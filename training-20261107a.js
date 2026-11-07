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
  function sigmoid(x){return 1/(1+Math.exp(-Math.max(-12,Math.min(12,x))));}
  function trainWeights(samples,target,initial){
    const weights={...initial};
    const predict=s=>sigmoid(FEATURES.reduce((sum,k)=>sum+weights[k]*(s[k]||0)/1800,0));
    const loss=()=>samples.reduce((sum,s)=>{const p=Math.max(.0001,Math.min(.9999,predict(s)));return sum-(target*Math.log(p)+(1-target)*Math.log(1-p));},0)/Math.max(1,samples.length);
    const lossBefore=loss();
    for(let epoch=0;epoch<5;epoch++)for(const sample of samples){
      const p=predict(sample);
      for(const key of FEATURES)weights[key]=Math.max(.25,Math.min(2.5,weights[key]+.035*(target-p)*(sample[key]||0)/1800));
    }
    return {weights,lossBefore,lossAfter:loss()};
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
    loadWeights();
    let completed=0,decisive=0,firstWins=0,nodes=0,sampleCount=0;
    for(let game=0;game<games;game++){
      const state=makeStartPosition(),samples=[];
      for(let ply=0;ply<maxPlies&&state.phase==="move";ply++){
        samples.push(snapshotFeatures(state));
        const result=await S.findBestMove(state,{maxDepth:2,timeMs:130,maxNodes:1400,maxDeployCandidates:3});
        nodes+=result.nodes||0;
        if(!result.bestMove)break;
        const a=result.bestMove;
        const applied=a.type==="deploy"?E.deployPiece(state,a.row,a.col,state.turn,a.pieceId):
          E.movePiece(state,a.from.row,a.from.col,a.to.row,a.to.col,a.landingMode);
        if(!applied||!applied.ok)break;
        if(options.onProgress)options.onProgress({game:game+1,games,ply:ply+1,maxPlies,nodes,phase:"selfplay"});
        if(ply%4===3)await new Promise(resolve=>setTimeout(resolve,0));
      }
      const target=state.phase==="finished"?(state.winner==="先手"?1:0):sigmoid(AI.evaluate(state,"先手")/2600);
      if(state.phase==="finished"){decisive++;if(target===1)firstWins++;}
      sampleCount+=samples.length;
      const learned=trainWeights(samples,target,AI.getWeights());
      AI.setWeights(learned.weights);completed++;
      if(options.onProgress)options.onProgress({game:game+1,games,ply:state.moveNumber-1,maxPlies,nodes,phase:"learning",target,lossBefore:learned.lossBefore,lossAfter:learned.lossAfter});
    }
    const weights=AI.getWeights();saveWeights(weights,completed);
    return {games:completed,decisive,firstWins,samples:sampleCount,nodes,weights};
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