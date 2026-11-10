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
  function normalizeWeights(weights){
    const result={...BASELINE_WEIGHTS};
    for(const key of FEATURES){
      if(weights&&typeof weights[key]==="number"&&Number.isFinite(weights[key])&&weights[key]>=.25&&weights[key]<=2.5)result[key]=weights[key];
      else if(key!=="mateNet")throw new Error("評価関数の重みが不正です: "+key);
    }
    return result;
  }
  function validWeights(weights){try{normalizeWeights(weights);return true;}catch(_){return false;}}
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
      snapshot.champion&&snapshot.champion.weights?snapshot.champion.weights:BASELINE_WEIGHTS;
    AI.setWeights(normalizeWeights(active));
    return {games:snapshot.learned&&Number(snapshot.learned.games)||0,hasChampion:!!snapshot.champion,hasTournament:!!snapshot.tournament};
  }
  function restorePreviousBackup(){
    const snapshot=readStored(BACKUP_KEY);
    if(!snapshot)throw new Error("復元できるバックアップがありません。");
    return restoreSnapshot(snapshot);
  }
  const FEATURES=["material","hand","position","activity","mobility","threats","exposure","kingSafety","mateNet"];
  const BASELINE_WEIGHTS=Object.freeze({material:1,hand:1,position:1,activity:1,mobility:1,threats:1,exposure:1,kingSafety:1,mateNet:1});
  function finalOutcome(state,candidateSide){
    if(state.phase==="finished"&&state.winner)
      return {target:state.winner===candidateSide?1:-1,candidateFinalScore:null};
    const activeWeights=AI.getWeights();
    try{
      // 引き分けも共通の基準評価で優劣を測り、学習目標を一律0にしない。
      AI.setWeights(BASELINE_WEIGHTS);
      const firstScore=AI.evaluate(state,"先手");
      const candidateFinalScore=candidateSide==="先手"?firstScore:-firstScore;
      return {target:Math.tanh(candidateFinalScore/1200)*0.5,candidateFinalScore};
    }finally{AI.setWeights(activeWeights);}
  }
  const random=list=>list[Math.floor(Math.random()*list.length)];
  function snapshotFeatures(state){
    const b=AI.evaluateBreakdown(state),v={};
    for(const k of FEATURES)v[k]=(b["先手"][k]||0)-(b["後手"][k]||0);
    return v;
  }
  async function searchSetupPlacement(state,side){
    if(state.setupTurn!==side)throw new Error("配置順が一致しません。");
    const options={timeMs:100,maxNodes:100,rootCandidateLimit:12,replyCandidateLimit:6,
      rootBeam:4,replyBeam:3,allowFinish:false,requireNoCheckBoth:true};
    let result=await S.findBestSetupPlacement(state,options);
    if(!result.bestMove)result=await S.findBestSetupPlacement(state,{...options,requireNoCheckBoth:false});
    if(!result.bestMove)throw new Error(side+"の配置探索で合法手が見つかりません。");
    const action=result.bestMove;
    if(result.finishRecommended){
      const finish=E.finishSetup(state,side);
      if(!finish.ok)throw new Error("配置探索が選んだ「済」を実行できません: "+finish.reason);
    }
    const applied=E.placePiece(state,action.row,action.col,side,action.pieceId);
    if(!applied.ok)throw new Error("配置探索の着手に失敗: "+applied.reason);
    if(E.isInCheck(state,side))throw new Error("配置探索が自陣の帥手を許しました。");
    return result;
  }
  async function makeStartPosition(){
    const activeWeights=AI.getWeights();
    AI.setWeights(BASELINE_WEIGHTS);
    try{
      const state=E.createGameState();
      for(let i=0;i<12;i++){
        await searchSetupPlacement(state,"先手");
        await searchSetupPlacement(state,"後手");
      }
      for(const side of ["先手","後手"]){
        const finish=E.finishSetup(state,side);
        if(!finish.ok)throw new Error("自己対局の「済」に失敗: "+finish.reason);
        await searchSetupPlacement(state,side);
      }
      if(state.phase!=="move")throw new Error("初期配置を完了できませんでした。");
      return state;
    }finally{AI.setWeights(activeWeights);}
  }
  // TD(lambda): learn from each transition, not one label copied across a whole game.
  function valueOf(features,weights){
    const raw=FEATURES.reduce((sum,key)=>sum+weights[key]*(features[key]||0),0)/1800;
    return Math.tanh(Math.max(-8,Math.min(8,raw)));
  }
  function trainMateSamples(samples,initial){
    const weights={...initial};let updates=0;
    for(const sample of samples){
      const x=(sample.features&&sample.features.mateNet||0)/600;
      if(!x)continue;
      const prediction=Math.tanh(weights.mateNet*x),delta=sample.target-prediction;
      weights.mateNet=Math.max(.25,Math.min(2.5,weights.mateNet+.06*delta*(1-prediction*prediction)*x));
      updates++;
    }
    return {weights,updates};
  }
  function trainTrajectory(trajectory,finalTarget,initial){
    const weights={...initial},trace=Object.fromEntries(FEATURES.map(key=>[key,0]));
    const updateDiagnostics=Object.fromEntries(FEATURES.map(key=>[key,{tdDelta:0,regularization:0,net:0,absolute:0}]));
    const alpha=.0025,gamma=.985,lambda=.72,regularization=.06;
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
        const tdUpdate=delta*gradient*trace[key];
        const regularizationUpdate=-regularization*(weights[key]-1);
        const update=tdUpdate+regularizationUpdate;
        updateDiagnostics[key].tdDelta+=alpha*tdUpdate;
        updateDiagnostics[key].regularization+=alpha*regularizationUpdate;
        updateDiagnostics[key].net+=alpha*update;
        updateDiagnostics[key].absolute+=Math.abs(alpha*update);
        weights[key]=Math.max(.25,Math.min(2.5,weights[key]+alpha*update));
      }
      absoluteError+=Math.abs(delta);updates++;
    }
    return {weights,meanTdError:updates?absoluteError/updates:0,updates,updateDiagnostics};
  }
  function loadWeights(){
    try{const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");if(saved&&saved.weights)AI.setWeights(normalizeWeights(saved.weights));}catch(_){}
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
      if(saved&&saved.weights)return normalizeWeights(saved.weights);
    }catch(_){}
    return fallback;
  }
  const GAME_RECORDS_KEY="gungi-ai-tournament-games-v1";
  const LATEST_KIFU_KEY="gungi-ai-latest-kifu-v1";
  const LATEST_KIFUS_KEY="gungi-ai-latest-kifus-v1";
  const RECENT_RECORD_LIMIT=30;
  const OLDER_DECISIVE_LIMIT=10;
  function getLatestGameKifus(){
    try{const list=JSON.parse(localStorage.getItem(LATEST_KIFUS_KEY)||"null");if(Array.isArray(list))return list.filter(item=>item&&Array.isArray(item.history)).slice(0,2);const old=JSON.parse(localStorage.getItem(LATEST_KIFU_KEY)||"null");return old&&Array.isArray(old.history)?[old]:[];}catch(_){return [];}
  }
  function getLatestGameKifu(){return getLatestGameKifus()[0]||null;}
  function storeLatestGameKifu(kifu){
    const list=[kifu,...getLatestGameKifus().filter(item=>item.id!==kifu.id)].slice(0,2);
    localStorage.setItem(LATEST_KIFUS_KEY,JSON.stringify(list));localStorage.setItem(LATEST_KIFU_KEY,JSON.stringify(list[0]));
    const check=getLatestGameKifus();return !!(check[0]&&check[0].id===kifu.id&&check[0].history.length===kifu.history.length);
  }
  function migrateLegacyGameRecords(){
    try{
      const records=JSON.parse(localStorage.getItem(GAME_RECORDS_KEY)||"[]");
      if(!Array.isArray(records))return;
      const ordered=records.slice().sort((a,b)=>String(b&&b.savedAt||"").localeCompare(String(a&&a.savedAt||"")));
      if(!getLatestGameKifus().length){
        const legacy=ordered.filter(item=>item&&Array.isArray(item.history)&&item.history.length).slice(0,2).map(item=>({id:item.id,savedAt:item.savedAt||new Date().toISOString(),source:item.source||"過去の対局",history:item.history}));
        if(legacy.length){localStorage.setItem(LATEST_KIFUS_KEY,JSON.stringify(legacy));localStorage.setItem(LATEST_KIFU_KEY,JSON.stringify(legacy[0]));}
      }
      let changed=false;
      records.forEach(item=>{if(item&&Object.prototype.hasOwnProperty.call(item,"history")){delete item.history;changed=true;}});
      if(changed)localStorage.setItem(GAME_RECORDS_KEY,JSON.stringify(records));
    }catch(_){}
  }
  function saveTrainingGameRecord(record){
    if(!record||(!record.winner&&!record.draw)||!record.finalState)return {ok:false,error:"対局結果または最終盤面がありません。"};
    try{
      const stored=JSON.parse(localStorage.getItem(GAME_RECORDS_KEY)||"[]");
      const records=Array.isArray(stored)?stored.filter(item=>item&&item.finalState&&(item.winner||item.draw===true)):[];
      records.forEach(item=>{delete item.history;});
      const finalOnly={...record};delete finalOnly.history;
      records.push(finalOnly);
      const ordered=records.sort((a,b)=>String(b.savedAt||"").localeCompare(String(a.savedAt||"")));
      const kept=[...ordered.slice(0,RECENT_RECORD_LIMIT),...ordered.slice(RECENT_RECORD_LIMIT).filter(item=>item.winner&&!item.draw).slice(0,OLDER_DECISIVE_LIMIT)];
      records.length=0;records.push(...kept);
      localStorage.setItem(GAME_RECORDS_KEY,JSON.stringify(records));
      const checked=JSON.parse(localStorage.getItem(GAME_RECORDS_KEY)||"[]");
      if(!checked.some(item=>item.id===record.id&&item.finalState))return {ok:false,error:"最終局面の保存確認に失敗しました。"};
      const kifu={id:record.id,savedAt:record.savedAt||new Date().toISOString(),source:record.source||"自己学習",history:Array.isArray(record.history)?record.history.map(entry=>({...entry})):[]};
      if(!storeLatestGameKifu(kifu))return {ok:false,error:"棋譜の保存確認に失敗しました。"};
      return {ok:true,id:record.id,historyLength:check[0].history.length};
    }catch(error){return {ok:false,error:"端末の保存容量または保存領域の問題です: "+(error&&error.message||error)};}
  }
  function createWorker(){
    return new Worker("./training-worker-20261107a.js?v=20261110setupbeam1");
  }
  async function trainParallel(options={}){
    const continuous=options.continuous===true;
    const games=Math.max(1,Math.min(4,Number(options.games)||2));
    const deviceWorkers=Math.max(2,Math.min(4,(Number(navigator.hardwareConcurrency)||4)-1));
    const parallel=Math.max(2,Math.min(deviceWorkers,4,Number(options.parallelGames)||deviceWorkers));
    const maxPlies=Math.max(20,Math.min(108,Number(options.maxPlies)||108));
    let previousGames=0;
    try{const previous=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");previousGames=previous&&Number.isFinite(previous.games)?previous.games:0;}catch(_){}
    loadWeights();
    let candidate=AI.getWeights();
    const champion=championWeights();
    let completed=0,decisive=0,candidateWins=0,championWins=0,firstWins=0,secondWins=0,draws=0,adjudicatedGames=0,nodes=0,sampleCount=0,totalTdError=0,tdUpdates=0,totalMateUpdates=0;
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
          const recordSave=saveTrainingGameRecord({id:"training-"+Date.now().toString(36)+"-"+completed,pair:null,game:completed+1,source:"自己学習",candidateSide:r.candidateSide,winner:r.winner||null,draw:!!r.draw,candidateFinalScore:r.candidateFinalScore,plies:r.plies,savedAt:new Date().toISOString(),finalState:r.finalState,history:r.history});
          if(r.trajectory.length){
            const learned=trainTrajectory(r.trajectory,r.finalTarget,candidate);
            candidate=learned.weights;totalTdError+=learned.meanTdError;tdUpdates+=learned.updates;
          }
          completed++;
          saveWeights(candidate,previousGames+completed);
          if(options.onProgress)options.onProgress({
            game:completed,games,ply:r.plies,nodes,phase:"learning",target:r.finalTarget,
            adjudicated:r.adjudicated,adjudicationScore:r.adjudicationScore,adjudicatedGames,
            parallelGames:results.length,completedGames:completed,recordSaved:recordSave.ok,recordSaveError:recordSave.error||'',recordId:recordSave.id||'',recordHistoryLength:recordSave.historyLength||0,mateUpdates:totalMateUpdates,
            meanTdError:tdUpdates?totalTdError/tdUpdates:0,candidateWins,championWins,firstWins,secondWins,draws
          });
        }
        AI.setWeights(candidate);
        if(options.shouldStop&&options.shouldStop())break;
      }
    }finally{for(const worker of workers)worker.terminate();}
    AI.setWeights(candidate);saveWeights(candidate,previousGames+completed);
    return {games:completed,decisive,candidateWins,championWins,firstWins,secondWins,draws,adjudicatedGames,
      samples:sampleCount,nodes,tdUpdates,mateUpdates:totalMateUpdates,meanTdError:tdUpdates?totalTdError/tdUpdates:0,weights:candidate,parallelGames:parallel};
  }
  async function trainSequential(options={}){
    if(typeof Worker==="undefined")throw new Error("このブラウザでは学習用Workerを利用できません。Safariを最新版に更新して再読み込みしてください。");
    return trainParallel({...options,parallelGames:2});
  }
  async function train(options={}){
    const deviceWorkers=Math.max(2,Math.min(4,(Number(navigator.hardwareConcurrency)||4)-1));
    const requested=Math.max(2,Math.min(deviceWorkers,4,Number(options.parallelGames)||deviceWorkers));
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
    AI.setWeights(normalizeWeights(data.weights));
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({weights:AI.getWeights(),games:Math.max(0,Number(data.games)||0),updatedAt:new Date().toISOString()}));}catch(_){}
    return {weights:AI.getWeights(),games:Math.max(0,Number(data.games)||0)};
  }
  migrateLegacyGameRecords();
  window.GungiTraining=Object.freeze({train,trainSequential,trainParallel,loadWeights,saveWeights,makeStartPosition,exportData,importData,createBackup,restorePreviousBackup,getLatestGameKifu,getLatestGameKifus});
  loadWeights();
})();