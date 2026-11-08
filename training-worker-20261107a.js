/* Gungi AI — isolated parallel self-play worker. */
(() => {
  "use strict";
  self.window = self;
  importScripts(
    "./engine-20261107bb.js?v=20261108marshalfrontrow1",
    "./evaluation-20261107be.js?v=20261108matedirect1",
    "./search-20261107bd.js?v=20261108matequiescence1"
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
      return {target:Math.tanh(candidateFinalScore/1200)*0.5,candidateFinalScore};
    }finally{AI.setWeights(activeWeights);}
  }
  const random=list=>list[Math.floor(Math.random()*list.length)];
  const other=side=>side==="先手"?"後手":"先手";
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
  function randomPlacement(state,side){
    const hand=state.hands[side],count=state.history.filter(x=>x.type==="place"&&x.side===side).length;
    const preferred=count===0?[hand.find(p=>p.name==="帥")].filter(Boolean):[random(hand)];
    const orderedPieces=preferred.concat(hand.filter(p=>!preferred.some(q=>q.id===p.id)));
    const enemy=side==="先手"?"後手":"先手";
    let safeOwn=[],safeBoth=[],legalFallback=[];
    for(const piece of orderedPieces){
      if(!piece)continue;
      const squares=[];
      for(let row=0;row<E.SIZE;row++)for(let col=0;col<E.SIZE;col++){
        // 帥は各陣営の最前列に単独配置する。
        if(piece.name==="帥" && row!==(side==="先手"?E.SIZE-1:0))continue;
        if(E.canPlacePiece(state,row,col,piece))squares.push({row,col});
      }
      // まず選んだ駒で探し、帥手を解消できない場合だけ他の駒も調べる。
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
      if(ownSafeForPiece.length){
        safeOwn=ownSafeForPiece;
        // 選んだ駒だけで安全な配置が見つかったら、他の駒は調べない。
        break;
      }
    }
    // 自分の帥を守り、可能なら相手への配置直後の帥手も作らない。
    const choices=safeBoth.length?safeBoth:(safeOwn.length?safeOwn:legalFallback);
    if(!choices.length)throw new Error(side+"の配置可能なマスがありません。");
    const chosen=random(choices),result=E.placePiece(state,chosen.at.row,chosen.at.col,side,chosen.piece.id);
    if(!result.ok)throw new Error("自己対局の初期配置に失敗: "+result.reason);
    if(chosen.piece.name==="帥" && (state.board[chosen.at.row][chosen.at.col].length!==1 ||
      chosen.at.row!==(side==="先手"?E.SIZE-1:0)))
      throw new Error("帥を自陣の最前列に単独配置できませんでした。");
  }
  function makeStartPosition(){
    // 両陣営の帥が初手から取られる配置は作り直す。
    for(let attempt=0;attempt<20;attempt++){
      const state=E.createGameState();
      for(let i=0;i<12;i++){randomPlacement(state,"先手");randomPlacement(state,"後手");}
      for(const side of ["先手","後手"]){
        const finish=E.finishSetup(state,side);
        if(!finish.ok)throw new Error("自己対局の「済」に失敗: "+finish.reason);
        randomPlacement(state,side);
      }
      if(state.phase!=="move")throw new Error("初期配置を完了できませんでした。");
      if(!E.isInCheck(state,"先手")&&!E.isInCheck(state,"後手"))return state;
    }
    throw new Error("帥手を防げる初期配置を生成できませんでした。");
  }
  async function play(message){
    const {candidateWeights,championWeights,candidateSide,maxPlies=108,searchOptions={}}=message;
    const state=makeStartPosition(),trajectory=[],mateSamples=[];
    let nodes=0,plies=0;
    for(;plies<maxPlies&&state.phase==="move";plies++){
      const side=state.turn,isCandidate=side===candidateSide,positionFeatures=snapshotFeatures(state);
      if(isCandidate)trajectory.push(positionFeatures);
      AI.setWeights(isCandidate?candidateWeights:championWeights);
      const result=await S.findBestMove(state,{maxDepth:4,timeMs:450,maxNodes:8000,maxDeployCandidates:5,...searchOptions});
      nodes+=result.nodes||0;
      const mateScore=isCandidate?result.score:-result.score;
      if(Number.isFinite(mateScore)&&Math.abs(mateScore)>99900000)
        mateSamples.push({features:positionFeatures,target:mateScore>0?1:-1,source:"search-proof",ply:plies});
      if(!result.bestMove){
        state.phase="finished";state.winner=other(side);break;
      }
      const a=result.bestMove;
      const applied=a.type==="deploy"
        ?E.deployPiece(state,a.row,a.col,side,a.pieceId)
        :E.movePiece(state,a.from.row,a.from.col,a.to.row,a.to.col,a.landingMode);
      if(!applied||!applied.ok)throw new Error("学習対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
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
    const oriented=candidateSide==="先手"?trajectory:trajectory.map(f=>Object.fromEntries(FEATURES.map(k=>[k,-f[k]])));
    return {candidateSide,trajectory:oriented,mateSamples:directSamples,finalTarget,candidateFinalScore:outcome.candidateFinalScore,winner:state.winner||null,draw:state.phase!=="finished"||!state.winner,
      plies,nodes,adjudicated,adjudicationScore,
      finalState:{board:state.board,hands:state.hands,turn:state.turn,phase:state.phase,winner:state.winner,moveNumber:state.moveNumber},history:state.history.map(entry=>({...entry}))};
  }
  self.onmessage=async event=>{
    const {id,...message}=event.data||{};
    try{const result=await play(message);self.postMessage({id,ok:true,result});}
    catch(error){self.postMessage({id,ok:false,error:error&&error.message?error.message:String(error)});}
  };
})();