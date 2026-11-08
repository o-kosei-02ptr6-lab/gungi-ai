/* Gungi AI — isolated parallel self-play worker. */
(() => {
  "use strict";
  self.window = self;
  importScripts(
    "./engine-20261107bb.js?v=20261108marshalfrontrow1",
    "./evaluation-20261107be.js?v=20261108matedirect1",
    "./search-20261107bd.js?v=20261108setupsearch2"
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
  async function randomPlacement(state,side){
    if(state.setupTurn!==side)throw new Error("配置順が一致しません。");
    const result=await S.findBestSetupPlacement(state,{timeMs:120,maxNodes:260,allowFinish:false});
    if(!result.bestMove)throw new Error(side+"の配置可能なマスがありません。");
    if(result.finishRecommended){
      const finish=E.finishSetup(state,side);
      if(!finish.ok)throw new Error("自己学習AIの「済」に失敗: "+finish.reason);
    }
    const action=result.bestMove,placed=E.placePiece(state,action.row,action.col,side,action.pieceId);
    if(!placed.ok)throw new Error("自己学習AIの配置に失敗: "+placed.reason);
    if(E.isInCheck(state,side))throw new Error("自己学習AIが帥手を受ける配置を選びました。");
    if(action.pieceName==="帥"&&(state.board[action.row][action.col].length!==1||
      action.row!==(side==="先手"?E.SIZE-1:0)))throw new Error("帥の配置規則に違反しました。");
  }
  async function makeStartPosition(){
    for(let attempt=0;attempt<20;attempt++){
      const state=E.createGameState();
      for(let i=0;i<12;i++){await randomPlacement(state,"先手");await randomPlacement(state,"後手");}
      for(const side of ["先手","後手"]){
        const finish=E.finishSetup(state,side);
        if(!finish.ok)throw new Error("自己対局の「済」に失敗: "+finish.reason);
        await randomPlacement(state,side);
      }
      if(state.phase!=="move")throw new Error("初期配置を完了できませんでした。");
      if(!E.isInCheck(state,"先手")&&!E.isInCheck(state,"後手"))return state;
    }
    throw new Error("帥手を防げる初期配置を生成できませんでした。");
  }
  async function play(message){
    const {candidateWeights,championWeights,candidateSide,maxPlies=108,searchOptions={}}=message;
    const state=await makeStartPosition(),trajectory=[],mateSamples=[];
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