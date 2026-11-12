/* Gungi AI — isolated parallel self-play worker. */
(() => {
  "use strict";
  self.window = self;
  importScripts(
    "./engine-20261107bb.js?v=20261108cycle5",
    "./evaluation-20261107be.js?v=20261113evalfast1",
    "./search-20261108cycle3.js?v=20261112evalmemo1"
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
  async function searchSetupPlacement(state,side,diagnostics,allowFinish=true){
    if(state.setupTurn!==side)throw new Error("配置順が一致しません。");
    const options={timeMs:350,maxNodes:360,rootCandidateLimit:12,replyCandidateLimit:6,
      rootBeam:4,replyBeam:2,allowFinish,requireNoCheckBoth:true};
    let result=await S.findBestSetupPlacement(state,options);
    if(!result.bestMove){
      // If a neutral placement is impossible, retain own-king safety rather than
      // aborting a whole training game; record this exception in the report.
      result=await S.findBestSetupPlacement(state,{...options,requireNoCheckBoth:false});
      diagnostics.neutralFallbacks++;
    }
    if(!result.bestMove)throw new Error(side+"の配置探索で合法手が見つかりません。");
    const action=result.bestMove;
    if(result.finishRecommended){
      const finish=E.finishSetup(state,side);
      if(!finish.ok)throw new Error("配置探索が選んだ「済」を実行できません: "+finish.reason);
    }
    const applied=E.placePiece(state,action.row,action.col,side,action.pieceId);
    if(!applied.ok)throw new Error("配置探索の着手に失敗: "+applied.reason);
    if(E.isInCheck(state,side))throw new Error("配置探索が自陣の帥手を許しました。");
    diagnostics.placements++;
    diagnostics.nodes+=result.nodes||0;
    diagnostics.elapsedMs+=result.elapsedMs||0;
    diagnostics.candidates+=result.candidateCount||0;
    diagnostics.finishDecisions+=result.finishRecommended?1:0;
    return result;
  }
  function cloneSetupState(state){
    return {
      board:state.board.map(row=>row.map(stack=>stack.slice())),
      hands:{先手:state.hands["先手"].slice(),後手:state.hands["後手"].slice()},
      turn:state.turn,setupTurn:state.setupTurn,
      setupDone:{...state.setupDone},setupFinishPending:state.setupFinishPending,
      phase:state.phase,winner:state.winner,moveNumber:state.moveNumber,
      history:state.history.slice()
    };
  }
  function randomizeBalancedOpening(state,seed,diagnostics){
    // 帥を双方が置いた直後に、低〜中価値の同一駒を3組だけ対称配置する。
    // 駒数と種類を完全に揃え、重要駒（将・弓・砲・筒・謀・騎・忍・砦）は残す。
    const rng=makeRng(seed^0x51A7B1E);
    const pairNames=["兵","侍","槍"];
    for(const name of pairNames){
      let placed=false;
      for(let attempt=0;attempt<80&&!placed;attempt++){
        const candidates=[];
        for(let row=6;row<=8;row++)for(let col=0;col<E.SIZE;col++){
          const mirrorRow=8-row;
          const firstStack=state.board[row][col],secondStack=state.board[mirrorRow][col];
          if(firstStack.length||secondStack.length)continue;
          const firstPiece=state.hands["先手"].find(piece=>piece.name===name);
          const secondPiece=state.hands["後手"].find(piece=>piece.name===name);
          if(firstPiece&&secondPiece&&E.canPlacePiece(state,row,col,firstPiece)&&
             E.canPlacePiece(state,mirrorRow,col,secondPiece))candidates.push({row,col,mirrorRow,firstPiece,secondPiece});
        }
        if(!candidates.length)break;
        const choice=random(candidates,rng),backup=cloneSetupState(state);
        const first=E.placePiece(state,choice.row,choice.col,"先手",choice.firstPiece.id);
        const second=first.ok?E.placePiece(state,choice.mirrorRow,choice.col,"後手",choice.secondPiece.id):{ok:false};
        if(first.ok&&second.ok&&!E.isInCheck(state,"先手")&&!E.isInCheck(state,"後手")){
          placed=true;
          diagnostics.randomPlacements+=2;
          diagnostics.randomPairs++;
          diagnostics.randomPieceTypes.push(name);
        }else{
          Object.assign(state,backup);
        }
      }
      if(!placed)diagnostics.randomPairSkips++;
    }
  }
  async function makeStartPosition(seed){
    const activeWeights=AI.getWeights();
    AI.setWeights(BASELINE_WEIGHTS);
    try{
      const state=E.createGameState();
      const setupDiagnostics={placements:0,nodes:0,elapsedMs:0,candidates:0,neutralFallbacks:0,
        finishDecisions:0,randomPlacements:0,randomPairs:0,randomPairSkips:0,randomPieceTypes:[]};
      // First place both Marshals using the existing setup search.
      for(let step=0;step<2;step++){
        if(state.phase!=="setup")throw new Error("帥配置中に配置フェーズが終了しました。");
        await searchSetupPlacement(state,state.setupTurn,setupDiagnostics,false);
      }
      if(!["先手","後手"].every(side=>state.history.some(entry=>entry.type==="place"&&entry.side===side&&entry.piece.name==="帥")))
        throw new Error("双方の帥配置を確認できません。");
      randomizeBalancedOpening(state,seed,setupDiagnostics);
      // Do not let the setup search end after only a Marshal and a few pieces.
      // Every side must deploy at least seven pieces (Marshal + six others) before 済
      // becomes an option. This prevents open-board, immediate-Marshal-capture games.
      const minimumSetupPiecesPerSide=7;
      for(let step=0;state.phase==="setup"&&step<50;step++){
        const side=state.setupTurn;
        const deployed=state.history.filter(entry=>entry.type==="place"&&entry.side===side).length;
        await searchSetupPlacement(state,side,setupDiagnostics,deployed>=minimumSetupPiecesPerSide);
      }
      if(state.phase!=="move")throw new Error("配置探索が52回以内に初期配置を完了できませんでした。");
      const deployedBySide=Object.fromEntries(["先手","後手"].map(side=>[
        side,state.history.filter(entry=>entry.type==="place"&&entry.side===side).length
      ]));
      setupDiagnostics.deployedBySide=deployedBySide;
      setupDiagnostics.minimumSetupPiecesPerSide=minimumSetupPiecesPerSide;
      if(Object.values(deployedBySide).some(count=>count<minimumSetupPiecesPerSide))
        throw new Error("初期配置の駒数が安全基準を満たしていません。");
      if(E.isInCheck(state,"先手")||E.isInCheck(state,"後手"))
        throw new Error("初期配置完了時点で帥手が発生しています。");
      return {state,setupDiagnostics};
    }finally{AI.setWeights(activeWeights);}
  }
  function positionKey(state){
    const board=state.board.map(row=>row.map(stack=>stack.map(p=>p.side+":"+p.name).join(",")).join("/")).join("|");
    const hands=["先手","後手"].map(side=>state.hands[side].map(p=>p.name).sort().join(",")).join("|");
    return board+"#"+hands+"#"+state.turn;
  }
  function aPieceForTelemetry(state,action){
    if(!action)return null;
    if(action.type==="move"){
      const stack=state.board[action.from.row][action.from.col];
      const piece=stack&&stack[stack.length-1];
      return piece?{name:piece.name,id:piece.id}:null;
    }
    const piece=(state.hands[state.turn]||[]).find(item=>item.id===action.pieceId);
    return piece?{name:piece.name,id:piece.id}:null;
  }
  function describeSearchAction(action,piece){
    if(!action)return null;
    return action.type==="move"
      ?{type:"move",piece:piece?piece.name:null,from:{...action.from},to:{...action.to},landingMode:action.landingMode||"capture"}
      :{type:"deploy",piece:piece?piece.name:null,to:{row:action.row,col:action.col}};
  }
  async function play(message){
    const {candidateWeights,championWeights,candidateSide,maxPlies=108,searchOptions={},seed=1}=message;
    const setupStart=await makeStartPosition(seed),state=setupStart.state,setupDiagnostics=setupStart.setupDiagnostics;
    const startStateSnapshot={
      board:state.board.map(row=>row.map(stack=>stack.map(piece=>({side:piece.side,name:piece.name})))),
      hands:Object.fromEntries(["先手","後手"].map(s=>[s,(state.hands[s]||[]).map(piece=>piece.name).sort()])),
      turn:state.turn,phase:state.phase,moveNumber:state.moveNumber
    };
    const startKey=positionKey(state),trajectory=[],mateSamples=[],repetitionEvents=[],moveLog=[],searchTelemetry=[],positionSamples=[];
    const positionVisits=new Map([[startKey,{visits:1,lastPly:0,lastActionIndex:0}]]);
    let nodes=0,plies=0,captures=0,deployments=0,repeatedPositionVisits=0,
      threefoldPositionCount=0,maxPositionVisits=1,endReason="max-plies";
    for(;plies<maxPlies&&state.phase==="move";plies++){
      const side=state.turn,isCandidate=side===candidateSide,positionFeatures=snapshotFeatures(state);
      const positionSample={
        ply:plies,turn:side,positionKey:positionKey(state),
        board:state.board.map(row=>row.map(stack=>stack.map(piece=>({side:piece.side,name:piece.name})))),
        hands:Object.fromEntries(["先手","後手"].map(s=>[s,(state.hands[s]||[]).map(piece=>piece.name).sort()])),
        evaluationFeatures:positionFeatures
      };
      // 全局面を常に学習AI側の視点に統一する。手番による反転は行わない。
      trajectory.push(candidateSide==="先手"?positionFeatures:Object.fromEntries(FEATURES.map(k=>[k,-positionFeatures[k]])));
      AI.setWeights(isCandidate?candidateWeights:championWeights);
      const urgent=E.isInCheck(state,side);
      const iterations=[];
      const result=await S.findBestMove(state,{
        maxDepth:5,timeMs:urgent?900:600,maxNodes:urgent?14000:9000,maxDeployCandidates:8,
        ...searchOptions,
        onProgress:progress=>iterations.push({
          depth:progress.depth,nodes:progress.nodes,elapsedMs:progress.elapsedMs,score:progress.score
        })
      });
      nodes+=result.nodes||0;
      const selectedPiece=aPieceForTelemetry(state,result.bestMove);
      searchTelemetry.push({
        ply:plies+1,side,isCandidate,inCheck:urgent,
        requestedDepth:Math.max(1,Math.min(8,Number(searchOptions.maxDepth)||5)),
        completedDepth:Number.isFinite(result.depth)?result.depth:0,
        nodes:result.nodes||0,quiescenceNodes:result.quiescenceNodes||0,
        quiescenceDiagnostics:result.quiescenceDiagnostics||{},
        cutoffs:result.cutoffs||0,transpositionHits:result.transpositionHits||0,
        checkCacheHits:result.checkCacheHits||0,
        evaluationCacheHits:result.evaluationCacheHits||0,
        positionEvaluationCacheHits:result.positionEvaluationCacheHits||0,
        positionEvaluationCacheMisses:result.positionEvaluationCacheMisses||0,
        evaluationKeyBuildMs:result.evaluationKeyBuildMs||0,
        evaluationComputeMs:result.evaluationComputeMs||0,
        legalMoveCacheHits:result.legalMoveCacheHits||0,
        elapsedMs:result.elapsedMs||0,score:Number.isFinite(result.score)?result.score:null,
        selectedMove:describeSearchAction(result.bestMove,selectedPiece),
        rootCandidateSource:result.rootCandidateSource||((result.rootCandidates||[]).length?"search":"none"),
        rootCandidates:(result.rootCandidates||[]).map(item=>({action:item.action,score:item.score})),
        iterations
      });
      const mateScore=isCandidate?result.score:-result.score;
      if(Number.isFinite(mateScore)&&Math.abs(mateScore)>99900000)
        mateSamples.push({features:positionFeatures,target:mateScore>0?1:-1,source:"search-proof",ply:plies});
      if(!result.bestMove){
        // 帥手中に応手がない場合は詰み。帥手でなければ従来どおり引き分け。
        if(E.isInCheck(state,side)&&!E.hasLegalCheckEvasion(state,side)){
          state.phase="finished";state.winner=side==="先手"?"後手":"先手";endReason="checkmate";
        }else{
          state.phase="finished";state.winner=null;endReason="no-legal-action";
        }
        break;
      }
      positionSample.search={
        requestedDepth:Math.max(1,Math.min(8,Number(searchOptions.maxDepth)||5)),
        completedDepth:Number.isFinite(result.depth)?result.depth:0,
        score:Number.isFinite(result.score)?Math.round(result.score):null,
        selectedMove:describeSearchAction(result.bestMove,selectedPiece),
        rootCandidateSource:result.rootCandidateSource||((result.rootCandidates||[]).length?"search":"none"),
        rootCandidates:(result.rootCandidates||[]).map(item=>({action:item.action,score:item.score}))
      };
      positionSamples.push(positionSample);
      const a=result.bestMove;
      const movingPiece=a.type==="move"?state.board[a.from.row][a.from.col].slice(-1)[0]:null;
      const deployingPiece=a.type==="deploy"?state.hands[side].find(piece=>piece.id===a.pieceId):null;
      const applied=a.type==="deploy"
        ?E.deployPiece(state,a.row,a.col,side,a.pieceId)
        :E.movePiece(state,a.from.row,a.from.col,a.to.row,a.to.col,a.landingMode);
      if(!applied||!applied.ok)throw new Error("学習対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
      if(a.type==="deploy")deployments++;
      if(applied.captured)captures+=applied.captured.length;
      // GitHub Actionsの実行ログに各手の実盤面を逐次出力し、学習中でも追跡可能にする。
      const liveBoard=state.board.map(row=>row.map(stack=>stack.length?
        stack.map(piece=>(piece.side==="先手"?"先":"後")+piece.name).join("+"):"."));
      console.log("GUNGI_TRAINING_POSITION "+JSON.stringify({
        gameSeed:seed,ply:plies+1,side,move:describeSearchAction(a,selectedPiece),
        board:liveBoard,turn:state.turn,phase:state.phase
      }));
      if(applied.gameOver&&applied.winner===side)endReason=applied.checkmate?"checkmate":"marshal-captured";
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
            cycleMoves:moveLog.slice(previous.lastActionIndex).slice(-24),
            cycleSearches:searchTelemetry.filter(item=>item.ply>previous.lastPly&&item.ply<=plies+1),
            cyclePositions:positionSamples.filter(sample=>sample.ply>=previous.lastPly&&sample.ply<plies+1).slice(-24)});
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
    return {candidateSide,startKey,setupDiagnostics,trajectory,mateSamples:directSamples,repetitionEvents,searchTelemetry,positionSamples,
      searchDepth:searchTelemetry.length?Math.max(...searchTelemetry.map(item=>item.completedDepth)):0,finalTarget,candidateFinalScore:outcome.candidateFinalScore,winner:state.winner||null,draw:state.phase!=="finished"||!state.winner,
      plies,nodes,captures,deployments,uniquePositions:positionVisits.size,repeatedPositionVisits,
      threefoldPositionCount,maxPositionVisits,endReason,adjudicated,adjudicationScore,
      startState:startStateSnapshot,
      finalState:{board:state.board,hands:state.hands,turn:state.turn,phase:state.phase,winner:state.winner,moveNumber:state.moveNumber},
      history:state.history.map(entry=>({...entry}))};
  }
  self.onmessage=async event=>{
    const {id,...message}=event.data||{};
    try{const result=await play(message);self.postMessage({id,ok:true,result});}
    catch(error){self.postMessage({id,ok:false,error:error&&error.message?error.message:String(error)});}
  };
})();