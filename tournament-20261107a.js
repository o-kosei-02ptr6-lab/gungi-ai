/* Gungi AI — paired self-play evaluator and conservative champion promotion. */
(() => {
  "use strict";
  const E=window.GungiEngine,AI=window.GungiAI,S=window.GungiSearch,T=window.GungiTraining;
  if(!E||!AI||!S||!T) throw new Error("Engine, evaluator, search and training must load before tournament.");
  const INITIAL=Object.freeze({material:1,hand:1,position:1,activity:1,mobility:1,threats:1,exposure:1,kingSafety:1,mateNet:1});
  // 引き分け局面の共通評価では、帥の安全・詰み筋を最優先する。
  const DRAW_EVAL_WEIGHTS=Object.freeze({...INITIAL,kingSafety:2.5,mateNet:2.5});
  const CHAMPION_KEY="gungi-ai-champion-weights-v1";
  const STATS_KEY="gungi-ai-tournament-stats-v2";
  const GAMES_KEY="gungi-ai-tournament-games-v1";
  const MAX_SAVED_GAMES=40;
  function saveGameRecord(record){
    if(!record||(!record.winner&&!record.draw)||!record.finalState)return {ok:false,error:"対局結果または最終盤面がありません。"};
    try{
      const stored=JSON.parse(localStorage.getItem(GAMES_KEY)||"[]");
      const records=Array.isArray(stored)?stored.filter(item=>item&&item.finalState&&(item.winner||item.draw===true)):[];
      const finalOnly={...record};delete finalOnly.history;records.push(finalOnly);
      while(records.length>MAX_SAVED_GAMES){const drawIndex=records.findIndex(item=>item.draw===true||!item.winner);records.splice(drawIndex>=0?drawIndex:0,1);}
      localStorage.setItem(GAMES_KEY,JSON.stringify(records));
      const kifu={id:record.id,savedAt:record.savedAt||new Date().toISOString(),source:"実力検証",history:Array.isArray(record.history)?record.history.map(entry=>({...entry})):[]};
      localStorage.setItem("gungi-ai-latest-kifu-v1",JSON.stringify(kifu));
      const verify=JSON.parse(localStorage.getItem("gungi-ai-latest-kifu-v1")||"null");
      return verify&&verify.id===record.id&&verify.history.length===kifu.history.length?{ok:true}:{ok:false,error:"棋譜の保存確認に失敗しました。"};
    }catch(error){return {ok:false,error:"対局記録または棋譜を保存できません: "+(error&&error.message||error)};}
  }
  function listGameRecords(){
    try{
      const records=JSON.parse(localStorage.getItem(GAMES_KEY)||"[]");
      return Array.isArray(records)?records.filter(item=>item&&item.finalState&&(item.winner||item.draw===true)):[];
    }catch(_){return [];}
  }
  const other=side=>side==="先手"?"後手":"先手";
  const clone=S.cloneState;
  const featureKeys=Object.keys(INITIAL);
  function normalize(weights){
    const result={};
    for(const key of featureKeys){
      const n=Number(weights&&weights[key]);
      if(key==="mateNet"&&(!weights||weights[key]==null)){result[key]=1;continue;}
      if(!Number.isFinite(n)||n<.25||n>2.5)throw new Error("評価関数の重みが不正です: "+key);
      result[key]=n;
    }
    return result;
  }
  function fingerprint(weights){return featureKeys.map(k=>k+":"+Number(weights[k]).toFixed(6)).join("|");}
  function readChampion(){
    try{
      const saved=JSON.parse(localStorage.getItem(CHAMPION_KEY)||"null");
      if(saved&&saved.weights)return normalize(saved.weights);
    }catch(_){}
    return {...INITIAL};
  }
  function saveChampion(weights){
    T.createBackup();
    try{localStorage.setItem(CHAMPION_KEY,JSON.stringify({weights,updatedAt:new Date().toISOString()}));}catch(_){}
  }
  function readStats(candidate){
    try{
      const saved=JSON.parse(localStorage.getItem(STATS_KEY)||"null");
      if(saved&&saved.fingerprint===fingerprint(candidate)&&
      Number.isFinite(saved.pairWins)&&Number.isFinite(saved.pairLosses)&&Number.isFinite(saved.pairDraws))return saved;
    }catch(_){}
    // 旧方式の個別局ベース統計はペア比較の統計と混ぜない。
    return {fingerprint:fingerprint(candidate),games:0,candidateWins:0,championWins:0,draws:0,adjudicated:0,pairs:0,pairWins:0,pairLosses:0,pairDraws:0,nodes:0,plies:0};
  }
  function saveStats(stats){T.createBackup();try{localStorage.setItem(STATS_KEY,JSON.stringify(stats));}catch(_){}}
  function wilsonBounds(rate,n){
    if(!n)return {lower:0,upper:1};
    const z=1.645,z2=z*z,den=1+z2/n;
    const center=rate+z2/(2*n);
    const margin=z*Math.sqrt((rate*(1-rate)+z2/(4*n))/n);
    return {lower:(center-margin)/den,upper:(center+margin)/den};
  }
  async function playOne(start,candidateSide,candidate,champion,settings,progress){
    const state=clone(start);
    let nodes=0,plies=0;
    for(;plies<settings.maxPlies&&state.phase==="move";plies++){
      const side=state.turn;
      AI.setWeights(side===candidateSide?candidate:champion);
      const result=await S.findBestMove(state,{
        maxDepth:settings.maxDepth,timeMs:settings.timeMs,maxNodes:settings.maxNodes,
        maxDeployCandidates:settings.maxDeployCandidates
      });
      nodes+=result.nodes||0;
      const action=result.bestMove;
      if(!action){state.phase="finished";state.winner=other(side);break;}
      const applied=action.type==="deploy"
        ?E.deployPiece(state,action.row,action.col,side,action.pieceId)
        :E.movePiece(state,action.from.row,action.from.col,action.to.row,action.to.col,action.landingMode);
      if(!applied||!applied.ok)throw new Error("対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
      if(progress)progress({side,plies:plies+1,nodes,phase:"game"});
      if(applied.gameOver)break;
      if(plies%2===1)await new Promise(resolve=>setTimeout(resolve,0));
    }
    // 規定手数までに帥を取れなかった対局は引き分け。
    // 固定評価関数による勝敗の後付けは行わない。
    const adjudicated=false,adjudicationScore=null;
    let candidateFinalScore=null;
    if(!state.winner){
      const activeWeights=AI.getWeights();
      try{
        // 引き分けの優劣は候補・最良AIどちらにも偏らない共通基準で測る。
        // 帥の安全性と詰み筋だけを通常の2.5倍にし、その他の項目は基準値のままにする。
        AI.setWeights(DRAW_EVAL_WEIGHTS);
        const firstPerspectiveScore=AI.evaluate(state,"先手");
        candidateFinalScore=candidateSide==="先手"?firstPerspectiveScore:-firstPerspectiveScore;
      }finally{AI.setWeights(activeWeights);}
    }
    return {
      winner:state.winner,plies:Math.min(plies+1,settings.maxPlies),nodes,
      draw:!state.winner,adjudicated,adjudicationScore,candidateFinalScore,
      finalState:{board:state.board,hands:state.hands,turn:state.turn,phase:state.phase,winner:state.winner,moveNumber:state.moveNumber},
      history:state.history.map(entry=>({...entry}))
    };
  }
  async function compare(options={}){
    const pairsPerBatch=Math.max(1,Math.min(5,Number(options.pairs)||2));
    const settings={
      maxPlies:Math.max(20,Math.min(108,Number(options.maxPlies)||108)),
      maxDepth:Math.max(1,Math.min(3,Number(options.maxDepth)||2)),
      timeMs:Math.max(50,Math.min(500,Number(options.timeMs)||60)),
      maxNodes:Math.max(250,Math.min(5000,Number(options.maxNodes)||700)),
      maxDeployCandidates:Math.max(2,Math.min(6,Number(options.maxDeployCandidates)||2))
    };
    const candidate=normalize(AI.getWeights()),original=AI.getWeights();
    let champion=readChampion();
    if(fingerprint(candidate)===fingerprint(champion)){
      return {alreadyChampion:true,games:0,scoreRate:1,championWeights:champion,candidateWeights:candidate};
    }
    const totals=readStats(candidate);
    totals.drawEvalSum=Number(totals.drawEvalSum)||0;
    totals.evaluatedDraws=Number(totals.evaluatedDraws)||0;
    totals.adjudicated=Number(totals.adjudicated)||0;
    const run={candidateWins:0,championWins:0,draws:0,games:0,nodes:0,plies:0,adjudicated:0,drawEvalSum:0,evaluatedDraws:0};
    let promoted=false,rejected=false,stopped=false;
    try{
      // Use a 90% confidence interval and a bounded sample for a faster, honest verdict.
      while(!promoted&&!rejected&&!stopped&&totals.games<200){
        for(let pair=0;pair<pairsPerBatch&&totals.games<200;pair++){
          if(options.shouldStop&&options.shouldStop()){stopped=true;break;}
          const pairNumber=totals.pairs+1;
          const start=T.makeStartPosition();
          const first=await playOne(start,"後手",candidate,champion,settings,p=>options.onProgress&&options.onProgress({...p,pair:pairNumber,game:1,totalGames:totals.games}));
          const second=await playOne(start,"先手",candidate,champion,settings,p=>options.onProgress&&options.onProgress({...p,pair:pairNumber,game:2,totalGames:totals.games}));
          for(const [result,candidateSide,gameNumber] of [[first,"後手",1],[second,"先手",2]]){
            saveGameRecord({id:Date.now().toString(36)+"-"+totals.games, savedAt:new Date().toISOString(), pair:pairNumber, game:gameNumber, candidateSide, winner:result.winner||null, draw:!!result.draw, candidateFinalScore:result.candidateFinalScore, plies:result.plies, savedAt:new Date().toISOString(), finalState:result.finalState, history:result.history});
            const candidateWon=!result.draw&&result.winner===candidateSide;
            const championWon=!result.draw&&!candidateWon;
            totals.games++;totals.nodes+=result.nodes;totals.plies+=result.plies;
            run.games++;run.nodes+=result.nodes;run.plies+=result.plies;
            if(result.adjudicated){totals.adjudicated++;run.adjudicated++;}
            if(result.draw){totals.draws++;run.draws++;if(Number.isFinite(result.candidateFinalScore)){totals.drawEvalSum+=result.candidateFinalScore;totals.evaluatedDraws++;run.drawEvalSum+=result.candidateFinalScore;run.evaluatedDraws++;}}
            else if(candidateWon){totals.candidateWins++;run.candidateWins++;}
            else{totals.championWins++;run.championWins++;}
          }
          totals.pairs++;
          // 同一初期配置で先後を入れ替えた2局を1組として比較する。
          // 2局の候補AI得点が1点超なら組勝ち、1点未満なら組負け、
          // ちょうど1点なら組引き分け。統計上の独立単位は「組」とする。
          const drawPoint = result => result.draw && Number.isFinite(result.candidateFinalScore)
            ? 0.3 + Math.max(-0.2,Math.min(0.2,Math.tanh(result.candidateFinalScore/1200)*0.2))
            : 0.3;
          const pairCandidateScore =
            (first.draw ? drawPoint(first) : first.winner === "後手" ? 1 : 0) +
            (second.draw ? drawPoint(second) : second.winner === "先手" ? 1 : 0);
          // 引き分けは基準0.3点、勝敗がついた局は同等実力時の期待値0.5点。
          // ペア内の引き分け数に応じて比較基準も変え、引き分け自体で不当に不利にならないようにする。
          const pairBaseline = (first.draw ? 0.3 : 0.5) + (second.draw ? 0.3 : 0.5);
          if(pairCandidateScore>pairBaseline+1e-9)totals.pairWins++;
          else if(pairCandidateScore<pairBaseline-1e-9)totals.pairLosses++;
          else totals.pairDraws++;
          saveStats(totals);
          const decisivePairs=totals.pairWins+totals.pairLosses;
          const pairedRate=decisivePairs?totals.pairWins/decisivePairs:0.5;
          const bounds=wilsonBounds(pairedRate,decisivePairs);
          if(totals.pairs>=20&&decisivePairs>=20&&bounds.lower>.5){
            saveChampion(candidate);champion=candidate;promoted=true;
            try{localStorage.removeItem(STATS_KEY);}catch(_){}
          }else if(totals.pairs>=20&&decisivePairs>=20&&bounds.upper<.5){
            AI.setWeights(champion);
            const saved=T.exportData();
            T.saveWeights(champion,saved.games||0);
            rejected=true;
            try{localStorage.removeItem(STATS_KEY);}catch(_){}
          }
          if(options.onProgress)options.onProgress({
            phase:"pairDone",pair:totals.pairs,pairs:pairsPerBatch,...run,
            totalGames:totals.games,totalCandidateWins:totals.candidateWins,
            totalChampionWins:totals.championWins,totalDraws:totals.draws,
            scoreRate: (totals.candidateWins+totals.draws*.5)/totals.games,
            pairedRate,pairedLowerBound:bounds.lower,pairedUpperBound:bounds.upper,
            pairWins:totals.pairWins,pairLosses:totals.pairLosses,pairDraws:totals.pairDraws,
            averageDrawEval:totals.evaluatedDraws?totals.drawEvalSum/totals.evaluatedDraws:0,evaluatedDraws:totals.evaluatedDraws,
            promoted,rejected
          });
          if(promoted||rejected)break;
        }
        if(!stopped&&!promoted&&!rejected&&options.onProgress){
          const decisivePairs=totals.pairWins+totals.pairLosses;
          const pairedRate=decisivePairs?totals.pairWins/decisivePairs:0.5;
          const bounds=wilsonBounds(pairedRate,decisivePairs);
          options.onProgress({phase:"continuing",totalGames:totals.games,scoreRate:(totals.candidateWins+totals.draws*.5)/totals.games,pairedRate,lowerBound:bounds.lower,upperBound:bounds.upper});
        }
      }
      const score=totals.candidateWins+totals.draws*.5;
      const scoreRate=totals.games?score/totals.games:0;
      const decisivePairs=totals.pairWins+totals.pairLosses;
      const pairedRate=decisivePairs?totals.pairWins/decisivePairs:0.5;
      const bounds=wilsonBounds(pairedRate,decisivePairs);
      const inconclusive=!promoted&&!rejected&&!stopped&&totals.games>=200;
      return {
        ...run,totalGames:totals.games,totalCandidateWins:totals.candidateWins,
        totalChampionWins:totals.championWins,totalDraws:totals.draws,
        totalAdjudicated:totals.adjudicated,scoreRate,pairedRate,
        pairWins:totals.pairWins,pairLosses:totals.pairLosses,pairDraws:totals.pairDraws,
        averageDrawEval:totals.evaluatedDraws?totals.drawEvalSum/totals.evaluatedDraws:0,evaluatedDraws:totals.evaluatedDraws,
        lowerBound:bounds.lower,upperBound:bounds.upper,
        promoted,rejected,stopped,inconclusive,candidateWeights:candidate,championWeights:champion,settings
      };
    } finally {if(!promoted&&!rejected)AI.setWeights(original);}
  }
  window.GungiTournament=Object.freeze({compare,baselineWeights:readChampion,championWeights:readChampion,listGameRecords});
})();