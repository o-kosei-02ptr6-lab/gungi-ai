/* Gungi AI — isolated parallel self-play worker. */
(() => {
  "use strict";
  self.window = self;
  importScripts(
    "./engine-20261107bb.js?v=20261108cycle5",
    "./evaluation-20261107be.js?v=20261108conversion1",
    "./search-20261108cycle2.js?v=20261108cycle12"
  );
  const E=self.GungiEngine, AI=self.GungiAI, S=self.GungiSearch;
  const FEATURES=["material","hand","position","activity","mobility","threats","exposure","kingSafety","mateNet"];
  const BASELINE_WEIGHTS=Object.freeze({material:1,hand:1,position:1,activity:1,mobility:1,threats:1,exposure:1,kingSafety:1,mateNet:1});
  function finalOutcome(state,candidateSide){
    if(state.phase==="finished"&&state.winner)
      return {target:state.winner===candidateSide?1:-1,candidateFinalScore:null};
    const activeWeights=AI.getWeights();
    try{
      AI.setWeights(BASELINE_WEIGHTS);
      const firstScore=AI.evaluate(state,"先手");
      const candidateFinalScore=candidateSide==="先手"?firstScore:-firstScore;
      const correction=Math.max(-0.2,Math.min(0.2,Math.tanh(candidateFinalScore/1200)*0.2));
      // 引き分けの基準点0.3に、最終局面の優劣を±0.2で反映する。
      return {target:0.3+correction,candidateFinalScore};
    }finally{AI.setWeights(activeWeights);}
  }
  const other=side=>side==="先手"?"後手":"先手";
  function makeRng(seed){
    let value=(Number(seed)||1)>>>0;
    return ()=>{ value=(value+0x6D2B79F5)>>>0; let t=value; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
  }
  function random(list,rng){return list[Math.floor(rng()*list.length)];}
  function snapshotFeatures(state){
    const b=AI.evaluateBreakdown(state),v={};
    for(const k of FEATURES)v[k]=(b["先手"][k]||0)-(b["後手"][k]||0);
    return v;
  }
  function cloneSetupState(state){
    return {
      ...state,
      board:state.board.map(row=>row.map(stack=>stack.slice())),
      hands:{"先手":state.hands["先手"].slice(),"後手":state.hands["後手"].slice()},
      history:state.history.slice(),
      setupDone:{...state.setupDone}
    };
  }
  function randomPlacement(state,side,rng){
    if(state.setupTurn!==side)throw new Error("配置順が一致しません。");
    const hand=state.hands[side],count=state.history.filter(x=>x.type==="place"&&x.side===side).length;
    const preferred=count===0?[hand.find(p=>p.name==="帥")].filter(Boolean):[random(hand,rng)];
    const orderedPieces=preferred.concat(hand.filter(p=>!preferred.some(q=>q.id===p.id)));
    const enemy=other(side);
    let safeOwn=[],safeBoth=[],legalFallback=[];
    for(const piece of orderedPieces){
      if(!piece)continue;
      const squares=[];
      for(let row=0;row<E.SIZE;row++)for(let col=0;col<E.SIZE;col++){
        if(piece.name==="帥"&&row!==(side==="先手"?E.SIZE-1:0))continue;
        if(E.canPlacePiece(state,row,col,piece))squares.push({row,col});
      }
      const ownSafeForPiece=[];
      for(const at of squares){
        const next=cloneSetupState(state);
        const result=E.placePiece(next,at.row,at.col,side,piece.id);
        if(!result.ok)continue;
        const candidate={piece,at};
        legalFallback.push(candidate);
        if(E.isInCheck(next,side))continue;
        ownSafeForPiece.push(candidate);
        if(!E.isInCheck(next,enemy))safeBoth.push(candidate);
      }
      if(ownSafeForPiece.length){safeOwn=ownSafeForPiece;break;}
    }
    const choices=safeBoth.length?safeBoth:(safeOwn.length?safeOwn:legalFallback);
    if(!choices.length)throw new Error(side+"の配置可能なマスがありません。");
    const chosen=random(choices,rng);
    const result=E.placePiece(state,chosen.at.row,chosen.at.col,side,chosen.piece.id);
    if(!result.ok)throw new Error("自己学習の初期配置に失敗: "+result.reason);
    if(chosen.piece.name==="帥"&&(state.board[chosen.at.row][chosen.at.col].length!==1||
      chosen.at.row!==(side==="先手"?E.SIZE-1:0)))throw new Error("帥の配置規則に違反しました。");
    if(E.isInCheck(state,side))throw new Error("自己学習AIが帥手を受ける配置を選びました。");
  }
  function positionKey(state){
    const board=state.board.map(row=>row.map(stack=>stack.map(p=>p.side+":"+p.name).join(",")).join("/")).join("|");
    const hands=["先手","後手"].map(side=>state.hands[side].map(p=>p.name).sort().join(",")).join("|");
    return board+"#"+hands+"#"+state.turn;
  }
  async function makeStartPosition(seed){
    const rng=makeRng(seed);
    for(let attempt=0;attempt<20;attempt++){
      const state=E.createGameState();
      for(let i=0;i<12;i++){randomPlacement(state,"先手",rng);randomPlacement(state,"後手",rng);}
      for(const side of ["先手","後手"]){
        const finish=E.finishSetup(state,side);
        if(!finish.ok)throw new Error("自己対局の「済」に失敗: "+finish.reason);
        randomPlacement(state,side,rng);
      }
      if(state.phase!=="move")throw new Error("初期配置を完了できませんでした。");
      if(!E.isInCheck(state,"先手")&&!E.isInCheck(state,"後手"))return state;
    }
    throw new Error("帥手を防げる初期配置を生成できませんでした。");
  }
  async function play(message){
    const {candidateWeights,championWeights,candidateSide,maxPlies=108,searchOptions={},seed=1}=message;
    const state=await makeStartPosition(seed),startKey=positionKey(state),trajectory=[],mateSamples=[],repetitionEvents=[],moveLog=[];
    const positionVisits=new Map([[startKey,{visits:1,lastPly:0,lastActionIndex:0}]]);
    let nodes=0,plies=0,captures=0,deployments=0,repeatedPositionVisits=0,
      threefoldPositionCount=0,maxPositionVisits=1,endReason="max-plies";
    for(;plies<maxPlies&&state.phase==="move";plies++){
      const side=state.turn,isCandidate=side===candidateSide,positionFeatures=snapshotFeatures(state);
      // 全局面を常に学習AI側の視点に統一する。手番による反転は行わない。
      trajectory.push(candidateSide==="先手"?positionFeatures:Object.fromEntries(FEATURES.map(k=>[k,-positionFeatures[k]])));
      AI.setWeights(isCandidate?candidateWeights:championWeights);
      const urgent=E.isInCheck(state,side);
      const result=await S.findBestMove(state,{maxDepth:5,timeMs:urgent?900:600,maxNodes:urgent?14000:9000,maxDeployCandidates:8,...searchOptions});
      nodes+=result.nodes||0;
      const mateScore=isCandidate?result.score:-result.score;
      if(Number.isFinite(mateScore)&&Math.abs(mateScore)>99900000)
        mateSamples.push({features:positionFeatures,target:mateScore>0?1:-1,source:"search-proof",ply:plies});
      if(!result.bestMove){
        // 合法手がない状態を、帥を取った勝ちと誤認して学習しない。
        // 帥手を無視する合法手も探索候補に含めたうえで、真に手がない場合は引き分け扱いにする。
        state.phase="finished";state.winner=null;endReason="no-legal-action";break;
      }
      const a=result.bestMove;
      const movingPiece=a.type==="move"?state.board[a.from.row][a.from.col].slice(-1)[0]:null;
      const deployingPiece=a.type==="deploy"?state.hands[side].find(piece=>piece.id===a.pieceId):null;
      const applied=a.type==="deploy"
        ?E.deployPiece(state,a.row,a.col,side,a.pieceId)
        :E.movePiece(state,a.from.row,a.from.col,a.to.row,a.to.col,a.landingMode);
      if(!applied||!applied.ok)throw new Error("学習対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
      if(a.type==="deploy")deployments++;
      if(applied.captured)captures+=applied.captured.length;
      if(applied.gameOver&&applied.winner===side)endReason="marshal-captured";
      const latestHistoryEntry=state.history[state.history.length-1];
      const historyMatchesAction=latestHistoryEntry&&latestHistoryEntry.type==="move"&&a.type==="move"&&
        latestHistoryEntry.from&&latestHistoryEntry.to&&
        latestHistoryEntry.from.row===a.from.row&&latestHistoryEntry.from.col===a.from.col&&
        latestHistoryEntry.to.row===a.to.row&&latestHistoryEntry.to.col===a.to.col;
      if(a.type==="move"){
        moveLog.push(historyMatchesAction?{...latestHistoryEntry}:{
          type:"move",piece:movingPiece?{...movingPiece}:null,from:{...a.from},to:{...a.to},
          fromLayer:a.from.layer,toLayer:a.to.layer,landingMode:a.landingMode,
          captured:Array.isArray(applied.captured)?applied.captured.slice():[]
        });
      }else{
        moveLog.push({
          type:"deploy",side,piece:deployingPiece?{...deployingPiece}:null,
          to:{row:a.row,col:a.col,layer:state.board[a.row][a.col].length}
        });
      }
      if(state.phase!=="finished"){
        const key=positionKey(state),previous=positionVisits.get(key),visits=(previous?previous.visits:0)+1;
        const currentActionIndex=moveLog.length;
        positionVisits.set(key,{visits,lastPly:plies+1,lastActionIndex:currentActionIndex});
        if(visits>1){
          repeatedPositionVisits++;
          repetitionEvents.push({ply:plies+1,previousPly:previous.lastPly,cycleLength:plies+1-previous.lastPly,visits,
            move:moveLog[moveLog.length-1]||null,
            cycleMoves:moveLog.slice(previous.lastActionIndex).slice(-24)});
        }
        if(visits===3)threefoldPositionCount++;
        maxPositionVisits=Math.max(maxPositionVisits,visits);
      }
      if(state.phase!=="finished"&&E.isInCheck(state,state.turn))
        mateSamples.push({features:snapshotFeatures(state),attackerSide:side,ply:plies+1,source:"played-check"});
    }
    // 規定手数までに帥を取れなければ引き分け。盤面評価で勝者を決めない。
    const adjudicated=false,adjudicationScore=null;
    const outcome=finalOutcome(state,candidateSide);
    const finalTarget=outcome.target;
    const directSamples=mateSamples.filter(sample=>sample.source==="search-proof"||
      (!!state.winner&&state.winner===sample.attackerSide&&plies+1-sample.ply<=8))
      .map(sample=>({features:candidateSide==="先手"?sample.features:Object.fromEntries(FEATURES.map(k=>[k,-sample.features[k]])),
        target:sample.source==="search-proof"?sample.target:(sample.attackerSide===candidateSide?1:-1)}));
    return {candidateSide,startKey,trajectory,mateSamples:directSamples,repetitionEvents,finalTarget,candidateFinalScore:outcome.candidateFinalScore,winner:state.winner||null,draw:state.phase!=="finished"||!state.winner,
      plies,nodes,captures,deployments,uniquePositions:positionVisits.size,repeatedPositionVisits,
      threefoldPositionCount,maxPositionVisits,endReason,adjudicated,adjudicationScore,
      finalState:{board:state.board,hands:state.hands,turn:state.turn,phase:state.phase,winner:state.winner,moveNumber:state.moveNumber},history:state.history.map(entry=>({...entry}))};
  }
  self.onmessage=async event=>{
    const {id,...message}=event.data||{};
    try{const result=await play(message);self.postMessage({id,ok:true,result});}
    catch(error){self.postMessage({id,ok:false,error:error&&error.message?error.message:String(error)});}
  };
})();