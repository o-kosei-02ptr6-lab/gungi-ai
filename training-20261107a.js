/* Gungi AI — lightweight browser self-play trainer. Outcome-supervised linear evaluation tuning. */
(() => {
  "use strict";
  const E=window.GungiEngine,AI=window.GungiAI,S=window.GungiSearch;
  if(!E||!AI||!S) throw new Error("Engine, evaluator and search must load before training.");
  const STORAGE_KEY="gungi-ai-learned-weights-v1";
  const FEATURES=["material","hand","position","activity","mobility","threats","exposure","kingSafety"];
  const random=list=>list[Math.floor(Math.random()*list.length)];
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
    for(let row=0;row<E.SIZE;row++)for(let col=0;col<E.SIZE;col++)
      if(E.canPlacePiece(state,row,col,piece))squares.push({row,col});
    if(!squares.length)throw new Error(side+"の配置可能なマスがありません。");
    const at=random(squares),result=E.placePiece(state,at.row,at.col,side,piece.id);
    if(!result.ok)throw new Error("自己対局の初期配置に失敗: "+result.reason);
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
  // TD(lambda): learn from each transition, not one label copied across a whole game.
  function valueOf(features,weights){
    const raw=FEATURES.reduce((sum,key)=>sum+weights[key]*(features[key]||0),0)/1800;
    return Math.tanh(Math.max(-8,Math.min(8,raw)));
  }
  function trainTrajectory(trajectory,finalTarget,initial){
    const weights={...initial},trace=Object.fromEntries(FEATURES.map(key=>[key,0]));
    const alpha=.0025,gamma=.985,lambda=.72;
    let absoluteError=0,updates=0;
    for(let i=0;i<trajectory.length;i++){
      const current=trajectory[i];
      const currentValue=valueOf(current,weights);
      const terminal=i===trajectory.length-1;
      const nextValue=terminal?finalTarget:valueOf(trajectory[i+1],weights);
      const delta=(terminal?finalTarget:gamma*nextValue)-currentValue;
      for(const key of FEATURES){
        trace[key]=gamma*lambda*trace[key]+(current[key]||0)/1800;
        const gradient=1-currentValue*currentValue;
        weights[key]=Math.max(.25,Math.min(2.5,weights[key]+alpha*delta*gradient*trace[key]));
      }
      absoluteError+=Math.abs(delta);updates++;
    }
    return {weights,meanTdError:updates?absoluteError/updates:0,updates};
  }
  function loadWeights(){
    try{const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");if(saved&&saved.weights)AI.setWeights(saved.weights);}catch(_){}
    return AI.getWeights();
  }
  function saveWeights(weights,games){
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({weights,games,updatedAt:new Date().toISOString()}));}catch(_){}
  }
  async function train(options={}){
    const games=Math.max(1,Math.min(4,Number(options.games)||2));
    const maxPlies=Math.max(20,Math.min(80,Number(options.maxPlies)||48));
    let previousGames=0;
    try{const previous=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");previousGames=previous&&Number.isFinite(previous.games)?previous.games:0;}catch(_){}
    loadWeights();
    let completed=0,decisive=0,firstWins=0,nodes=0,sampleCount=0,totalTdError=0,tdUpdates=0;
    for(let game=0;game<games;game++){
      const state=makeStartPosition(),trajectory=[];
      for(let ply=0;ply<maxPlies&&state.phase==="move";ply++){
        trajectory.push(snapshotFeatures(state));
        const result=await S.findBestMove(state,{maxDepth:2,timeMs:130,maxNodes:1400,maxDeployCandidates:3});
        nodes+=result.nodes||0;
        if(!result.bestMove)break;
        const action=result.bestMove;
        const applied=action.type==="deploy"
          ?E.deployPiece(state,action.row,action.col,state.turn,action.pieceId)
          :E.movePiece(state,action.from.row,action.from.col,action.to.row,action.to.col,action.landingMode);
        if(!applied||!applied.ok)break;
        if(options.onProgress)options.onProgress({game:game+1,games,ply:ply+1,maxPlies,nodes,phase:"selfplay"});
        if(ply%4===3)await new Promise(resolve=>setTimeout(resolve,0));
      }
      // The target is always expressed from 先手's perspective.
      const finalTarget=state.phase==="finished"
        ?(state.winner==="先手"?1:-1)
        :valueOf(snapshotFeatures(state),AI.getWeights());
      if(state.phase==="finished"){decisive++;if(state.winner==="先手")firstWins++;}
      sampleCount+=trajectory.length;
      if(trajectory.length){
        const learned=trainTrajectory(trajectory,finalTarget,AI.getWeights());
        AI.setWeights(learned.weights);
        totalTdError+=learned.meanTdError;tdUpdates+=learned.updates;
      }
      completed++;
      if(options.onProgress)options.onProgress({
        game:game+1,games,ply:state.moveNumber-1,maxPlies,nodes,phase:"learning",
        target:finalTarget,meanTdError:tdUpdates?totalTdError/tdUpdates:0
      });
    }
    const weights=AI.getWeights();saveWeights(weights,previousGames+completed);
    return {games:completed,decisive,firstWins,samples:sampleCount,nodes,tdUpdates,
      meanTdError:tdUpdates?totalTdError/tdUpdates:0,weights};
  }
  function exportData(){
    let saved=null;
    try{saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");}catch(_){}
    return {
      format:"gungi-ai-training-transfer",
      version:1,
      exportedAt:new Date().toISOString(),
      weights:AI.getWeights(),
      games:saved&&Number.isFinite(saved.games)?saved.games:0,
      learnedAt:saved&&saved.updatedAt?saved.updatedAt:null
    };
  }
  function importData(input){
    const data=typeof input==="string"?JSON.parse(input):input;
    if(!data||data.format!=="gungi-ai-training-transfer"||data.version!==1)
      throw new Error("引き継ぎデータの形式またはバージョンが違います。");
    if(!data.weights||typeof data.weights!=="object")
      throw new Error("評価関数の重みが見つかりません。");
    for(const key of FEATURES){
      const value=data.weights[key];
      if(typeof value!=="number"||!Number.isFinite(value)||value<0.25||value>2.5)
        throw new Error("重み「"+key+"」の値が不正です。");
    }
    AI.setWeights(data.weights);
    saveWeights(AI.getWeights(),Math.max(0,Number(data.games)||0));
    return {weights:AI.getWeights(),games:Math.max(0,Number(data.games)||0)};
  }
  window.GungiTraining=Object.freeze({train,loadWeights,saveWeights,makeStartPosition,exportData,importData});
  loadWeights();
})();