/* Gungi AI — lightweight browser self-play trainer. Outcome-supervised linear evaluation tuning. */
(() => {
  "use strict";
  const E=window.GungiEngine,AI=window.GungiAI,S=window.GungiSearch;
  if(!E||!AI||!S) throw new Error("Engine, evaluator and search must load before training.");
  const STORAGE_KEY="gungi-ai-learned-weights-v1";
  const CHAMPION_KEY="gungi-ai-champion-weights-v1";
  const STATS_KEY="gungi-ai-tournament-stats-v2";
  const BACKUP_KEY="gungi-ai-previous-backup-v1";
  function readStored(key){try{return JSON.parse(localStorage.getItem(key)||"null");}catch(_){return null;}}
  function currentSnapshot(){
    return {format:"gungi-ai-full-backup",version:1,createdAt:new Date().toISOString(),
      learned:readStored(STORAGE_KEY),champion:readStored(CHAMPION_KEY),tournament:readStored(STATS_KEY)};
  }
  function createBackup(){
    try{localStorage.setItem(BACKUP_KEY,JSON.stringify(currentSnapshot()));return true;}catch(_){return false;}
  }
  function validWeights(weights){
    return !!weights&&FEATURES.every(key=>typeof weights[key]==="number"&&Number.isFinite(weights[key])&&weights[key]>=.25&&weights[key]<=2.5);
  }
  function restoreSnapshot(snapshot){
    if(!snapshot||snapshot.format!=="gungi-ai-full-backup"||snapshot.version!==1)
      throw new Error("バックアップの形式またはバージョンが違います。");
    if(snapshot.learned&&(!snapshot.learned.weights||!validWeights(snapshot.learned.weights)))
      throw new Error("学習AIの重みが不正です。");
    if(snapshot.champion&&(!snapshot.champion.weights||!validWeights(snapshot.champion.weights)))
      throw new Error("最良AIの重みが不正です。");
    if(snapshot.tournament&&(typeof snapshot.tournament!=="object"||!Number.isFinite(Number(snapshot.tournament.games))))
      throw new Error("検証記録が不正です。");
    createBackup();
    for(const [key,value] of [[STORAGE_KEY,snapshot.learned],[CHAMPION_KEY,snapshot.champion],[STATS_KEY,snapshot.tournament]]){
      if(value==null)localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify(value));
    }
    const active=snapshot.learned&&snapshot.learned.weights?snapshot.learned.weights:
      snapshot.champion&&snapshot.champion.weights?snapshot.champion.weights:Object.fromEntries(FEATURES.map(key=>[key,1]));
    AI.setWeights(active);
    return {games:snapshot.learned&&Number(snapshot.learned.games)||0,hasChampion:!!snapshot.champion,hasTournament:!!snapshot.tournament};
  }
  function restorePreviousBackup(){
    const snapshot=readStored(BACKUP_KEY);
    if(!snapshot)throw new Error("復元できるバックアップがありません。");
    return restoreSnapshot(snapshot);
  }
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
    createBackup();
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({weights,games,updatedAt:new Date().toISOString()}));}catch(_){}
  }
  function championWeights(){
    const keys=FEATURES;
    const fallback=Object.fromEntries(keys.map(key=>[key,1]));
    try{
      const saved=JSON.parse(localStorage.getItem("gungi-ai-champion-weights-v1")||"null");
      if(saved&&saved.weights&&keys.every(key=>Number.isFinite(saved.weights[key])&&saved.weights[key]>=.25&&saved.weights[key]<=2.5))
        return Object.fromEntries(keys.map(key=>[key,saved.weights[key]]));
    }catch(_){}
    return fallback;
  }
  const GAME_RECORDS_KEY="gungi-ai-tournament-games-v1";
  const MAX_SAVED_GAMES=40;
  function saveTrainingGameRecord(record){
    if(!record||(!record.winner&&!record.draw)||!record.finalState)return;
    try{
      const stored=JSON.parse(localStorage.getItem(GAME_RECORDS_KEY)||"[]");
      const records=Array.isArray(stored)?stored.filter(item=>item&&item.finalState&&(item.winner||item.draw)):[];
      records.push(record);
      while(records.length>MAX_SAVED_GAMES){
        const oldestDraw=records.findIndex(item=>item.draw===true||!item.winner);
        records.splice(oldestDraw>=0?oldestDraw:0,1);
      }
      localStorage.setItem(GAME_RECORDS_KEY,JSON.stringify(records));
    }catch(_){}
  }
  async function trainSequential(options={}){
    const continuous=options.continuous===true;
    const games=Math.max(1,Math.min(4,Number(options.games)||2));
    const maxPlies=Math.max(20,Math.min(108,Number(options.maxPlies)||108));
    let previousGames=0;
    try{const previous=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");previousGames=previous&&Number.isFinite(previous.games)?previous.games:0;}catch(_){}
    loadWeights();
    let candidate=AI.getWeights();
    const champion=championWeights();
    let completed=0,decisive=0,candidateWins=0,championWins=0,firstWins=0,secondWins=0,draws=0,adjudicatedGames=0,nodes=0,sampleCount=0,totalTdError=0,tdUpdates=0;
    for(let game=0;continuous||game<games;game++){
      if(options.shouldStop&&options.shouldStop())break;
      const state=makeStartPosition(),candidateSide=game%2===0?"先手":"後手",trajectory=[];
      let plies=0;
      for(;plies<maxPlies&&state.phase==="move";plies++){
        const side=state.turn;
        const isCandidate=side===candidateSide;
        if(isCandidate)trajectory.push(snapshotFeatures(state));
        AI.setWeights(isCandidate?candidate:champion);
        const result=await S.findBestMove(state,{maxDepth:3,timeMs:180,maxNodes:2500,maxDeployCandidates:3});
        nodes+=result.nodes||0;
        if(!result.bestMove){
          state.phase="finished";state.winner=otherSide(side);
          break;
        }
        const action=result.bestMove;
        const applied=action.type==="deploy"
          ?E.deployPiece(state,action.row,action.col,side,action.pieceId)
          :E.movePiece(state,action.from.row,action.from.col,action.to.row,action.to.col,action.landingMode);
        if(!applied||!applied.ok)throw new Error("学習対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
        if(options.onProgress)options.onProgress({game:game+1,games,ply:plies+1,maxPlies,nodes,phase:"selfplay",candidateSide,opponent:"保存済み最良AI"});
        if(plies%4===3)await new Promise(resolve=>setTimeout(resolve,0));
      }
      // 規定手数までに帥を取れなかった対局は引き分けとして扱う。
      // 盤面評価で勝者を作らず、実際の終局結果だけを学習ラベルにする。
      const adjudicated=false;
      const adjudicationScore=null;
      const finalTarget=state.phase==="finished"
        ?(state.winner===candidateSide?1:-1):0;
      if(adjudicated)adjudicatedGames++;
      const isDraw=state.phase!=="finished"||!state.winner;
      saveTrainingGameRecord({id:"training-"+Date.now().toString(36)+"-"+game,pair:null,game:game+1,source:"自己学習",candidateSide,winner:state.winner||null,draw:isDraw,plies:Math.min(plies+1,maxPlies),savedAt:new Date().toISOString(),finalState:{board:state.board,hands:state.hands,turn:state.turn,phase:state.phase,winner:state.winner||null,moveNumber:state.moveNumber}});
      if(!isDraw){
        decisive++;
        if(state.winner===candidateSide)candidateWins++;else championWins++;
        if(state.winner==="先手")firstWins++;else secondWins++;
      }else draws++;
      sampleCount+=trajectory.length;
      AI.setWeights(candidate);
      if(trajectory.length){
        const oriented= candidateSide==="先手" ? trajectory : trajectory.map(features=>Object.fromEntries(FEATURES.map(key=>[key,-features[key]])));
        const learned=trainTrajectory(oriented,finalTarget,candidate);
        candidate=learned.weights;AI.setWeights(candidate);
        totalTdError+=learned.meanTdError;tdUpdates+=learned.updates;
      }
      completed++;
      saveWeights(candidate,previousGames+completed);
      if(options.onProgress)options.onProgress({
        game:game+1,games,ply:plies,nodes,phase:"learning",target:finalTarget,
        adjudicated,adjudicationScore,adjudicatedGames,
        meanTdError:tdUpdates?totalTdError/tdUpdates:0,candidateWins,championWins,firstWins,secondWins,draws
      });
      if(options.shouldStop&&options.shouldStop())break;
    }
    AI.setWeights(candidate);
    saveWeights(candidate,previousGames+completed);
    return {games:completed,decisive,candidateWins,championWins,firstWins,secondWins,draws,adjudicatedGames,
      samples:sampleCount,nodes,tdUpdates,meanTdError:tdUpdates?totalTdError/tdUpdates:0,weights:candidate};
  }

  function createWorker(){
    return new Worker("./training-worker-20261107a.js?v=20261108max108");
  }
  async function trainParallel(options={}){
    const continuous=options.continuous===true;
    const games=Math.max(1,Math.min(4,Number(options.games)||2));
    const parallel=Math.max(2,Math.min(4,Number(options.parallelGames)||2));
    const maxPlies=Math.max(20,Math.min(108,Number(options.maxPlies)||108));
    let previousGames=0;
    try{const previous=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");previousGames=previous&&Number.isFinite(previous.games)?previous.games:0;}catch(_){}
    loadWeights();
    let candidate=AI.getWeights();
    const champion=championWeights();
    let completed=0,decisive=0,candidateWins=0,championWins=0,firstWins=0,secondWins=0,draws=0,adjudicatedGames=0,nodes=0,sampleCount=0,totalTdError=0,tdUpdates=0;
    const workers=[];
    try{
      for(let i=0;i<parallel;i++)workers.push(createWorker());
      for(let batch=0;continuous||completed<games;batch++){
        if(options.shouldStop&&options.shouldStop())break;
        const count=continuous?parallel:Math.min(parallel,games-completed);
        const candidateSnapshot={...candidate},championSnapshot={...champion};
        const jobs=Array.from({length:count},(_,i)=>new Promise((resolve,reject)=>{
          const worker=workers[i];
          const id="gungi-"+batch+"-"+i;
          const cleanup=()=>{
            worker.removeEventListener("message",onMessage);
            worker.removeEventListener("error",onError);
          };
          const onMessage=event=>{
            if(!event.data||event.data.id!==id)return;
            cleanup();
            if(event.data.ok)resolve(event.data.result);
            else reject(new Error(event.data.error||"並列学習Workerでエラーが発生しました。"));
          };
          const onError=event=>{cleanup();reject(new Error(event.message||"並列学習Workerを実行できません。"));};
          worker.addEventListener("message",onMessage);
          worker.addEventListener("error",onError);
          worker.postMessage({id,candidateWeights:candidateSnapshot,championWeights:championSnapshot,
            candidateSide:(completed+i)%2===0?"先手":"後手",maxPlies});
        }));
        if(options.onProgress)options.onProgress({game:completed+1,games,ply:0,maxPlies,nodes,phase:"parallel",parallelGames:count,completedGames:completed});
        const results=await Promise.all(jobs);
        // All games in a batch use identical weights; apply their updates in a
        // deterministic order only after every isolated worker has finished.
        for(let i=0;i<results.length;i++){
          const r=results[i];
          nodes+=r.nodes||0;sampleCount+=r.trajectory.length;
          if(r.adjudicated)adjudicatedGames++;
          if(r.draw)draws++;
          else{decisive++;if(r.finalTarget>0)candidateWins++;else championWins++;if(r.winner==="先手")firstWins++;else secondWins++;}
          saveTrainingGameRecord({id:"training-"+Date.now().toString(36)+"-"+completed,pair:null,game:completed+1,source:"自己学習",candidateSide:r.candidateSide,winner:r.winner||null,draw:!!r.draw,plies:r.plies,savedAt:new Date().toISOString(),finalState:r.finalState});
          if(r.trajectory.length){
            const learned=trainTrajectory(r.trajectory,r.finalTarget,candidate);
            candidate=learned.weights;totalTdError+=learned.meanTdError;tdUpdates+=learned.updates;
          }
          completed++;
          saveWeights(candidate,previousGames+completed);
          if(options.onProgress)options.onProgress({
            game:completed,games,ply:r.plies,nodes,phase:"learning",target:r.finalTarget,
            adjudicated:r.adjudicated,adjudicationScore:r.adjudicationScore,adjudicatedGames,
            parallelGames:results.length,completedGames:completed,
            meanTdError:tdUpdates?totalTdError/tdUpdates:0,candidateWins,championWins,firstWins,secondWins,draws
          });
        }
        AI.setWeights(candidate);
        if(options.shouldStop&&options.shouldStop())break;
      }
    }finally{for(const worker of workers)worker.terminate();}
    AI.setWeights(candidate);saveWeights(candidate,previousGames+completed);
    return {games:completed,decisive,candidateWins,championWins,firstWins,secondWins,draws,adjudicatedGames,
      samples:sampleCount,nodes,tdUpdates,meanTdError:tdUpdates?totalTdError/tdUpdates:0,weights:candidate,parallelGames:parallel};
  }
  async function train(options={}){
    const requested=Math.max(1,Math.min(4,Number(options.parallelGames)||2));
    if(requested>1&&typeof Worker!=="undefined")return trainParallel({...options,parallelGames:requested});
    return trainSequential(options);
  }
  function otherSide(side){return side==="先手"?"後手":"先手";}
  function exportData(){
    const snapshot=currentSnapshot();
    return {...snapshot,exportedAt:new Date().toISOString()};
  }
  function importData(input){
    const data=typeof input==="string"?JSON.parse(input):input;
    if(data&&data.format==="gungi-ai-full-backup")return restoreSnapshot(data);
    if(!data||data.format!=="gungi-ai-training-transfer"||data.version!==1)
      throw new Error("引き継ぎデータの形式またはバージョンが違います。");
    if(!validWeights(data.weights))throw new Error("評価関数の重みが不正です。");
    createBackup();
    AI.setWeights(data.weights);
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({weights:AI.getWeights(),games:Math.max(0,Number(data.games)||0),updatedAt:new Date().toISOString()}));}catch(_){}
    return {weights:AI.getWeights(),games:Math.max(0,Number(data.games)||0)};
  }
  window.GungiTraining=Object.freeze({train,trainSequential,trainParallel,loadWeights,saveWeights,makeStartPosition,exportData,importData,createBackup,restorePreviousBackup});
  loadWeights();
})();