/* Gungi AI — isolated parallel self-play worker. */
(() => {
  "use strict";
  self.window = self;
  importScripts(
    "./engine-20261107bb.js?v=20261108marshalfrontrow1",
    "./evaluation-20261107be.js?v=20261108tsuketactics1",
    "./search-20261107bd.js?v=20261108marshalfrontrow1"
  );
  const E=self.GungiEngine, AI=self.GungiAI, S=self.GungiSearch;
  const FEATURES=["material","hand","position","activity","mobility","threats","exposure","kingSafety"];
  const random=list=>list[Math.floor(Math.random()*list.length)];
  const other=side=>side==="先手"?"後手":"先手";
  function snapshotFeatures(state){
    const b=AI.evaluateBreakdown(state),v={};
    for(const k of FEATURES)v[k]=(b["先手"][k]||0)-(b["後手"][k]||0);
    return v;
  }
  function randomPlacement(state,side){
    const hand=state.hands[side],count=state.history.filter(x=>x.type==="place"&&x.side===side).length;
    const piece=count===0?hand.find(p=>p.name==="帥"):random(hand);
    if(!piece)throw new Error(side+"の配置可能な駒がありません。");
    const squares=[];
    for(let row=0;row<E.SIZE;row++)for(let col=0;col<E.SIZE;col++){
      // 帥は各陣営の最前列に配置する。先手は最下段、後手は最上段。
      if(piece.name==="帥" && row!==(side==="先手"?E.SIZE-1:0))continue;
      if(E.canPlacePiece(state,row,col,piece))squares.push({row,col});
    }
    if(!squares.length)throw new Error(side+"の配置可能なマスがありません。");
    const at=random(squares),result=E.placePiece(state,at.row,at.col,side,piece.id);
    if(!result.ok)throw new Error("自己対局の初期配置に失敗: "+result.reason);
    if(piece.name==="帥" && (state.board[at.row][at.col].length!==1 ||
      at.row!==(side==="先手"?E.SIZE-1:0)))
      throw new Error("帥を自陣の最前列に単独配置できませんでした。");
  }
  function makeStartPosition(){
    const state=E.createGameState();
    for(let i=0;i<12;i++){randomPlacement(state,"先手");randomPlacement(state,"後手");}
    for(const side of ["先手","後手"]){
      const finish=E.finishSetup(state,side);
      if(!finish.ok)throw new Error("自己対局の「済」に失敗: "+finish.reason);
      randomPlacement(state,side);
    }
    if(state.phase!=="move")throw new Error("初期配置を完了できませんでした。");
    return state;
  }
  async function play(message){
    const {candidateWeights,championWeights,candidateSide,maxPlies=144,searchOptions={}}=message;
    const state=makeStartPosition(),trajectory=[];
    let nodes=0,plies=0;
    for(;plies<maxPlies&&state.phase==="move";plies++){
      const side=state.turn,isCandidate=side===candidateSide;
      if(isCandidate)trajectory.push(snapshotFeatures(state));
      AI.setWeights(isCandidate?candidateWeights:championWeights);
      const result=await S.findBestMove(state,{maxDepth:3,timeMs:180,maxNodes:2500,maxDeployCandidates:3,...searchOptions});
      nodes+=result.nodes||0;
      if(!result.bestMove){
        state.phase="finished";state.winner=other(side);break;
      }
      const a=result.bestMove;
      const applied=a.type==="deploy"
        ?E.deployPiece(state,a.row,a.col,side,a.pieceId)
        :E.movePiece(state,a.from.row,a.from.col,a.to.row,a.to.col,a.landingMode);
      if(!applied||!applied.ok)throw new Error("学習対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
    }
    // 規定手数までに帥を取れなければ引き分け。盤面評価で勝者を決めない。
    const adjudicated=false,adjudicationScore=null;
    const finalTarget=state.phase==="finished"?(state.winner===candidateSide?1:-1):0;
    const oriented=candidateSide==="先手"?trajectory:trajectory.map(f=>Object.fromEntries(FEATURES.map(k=>[k,-f[k]])));
    return {candidateSide,trajectory:oriented,finalTarget,winner:state.winner||null,draw:state.phase!=="finished",
      plies,nodes,adjudicated,adjudicationScore,
      finalState:{board:state.board,hands:state.hands,turn:state.turn,phase:state.phase,winner:state.winner,moveNumber:state.moveNumber}};
  }
  self.onmessage=async event=>{
    const {id,...message}=event.data||{};
    try{const result=await play(message);self.postMessage({id,ok:true,result});}
    catch(error){self.postMessage({id,ok:false,error:error&&error.message?error.message:String(error)});}
  };
})();