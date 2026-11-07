/* Gungi AI — paired self-play evaluator and conservative champion promotion. */
(() => {
  "use strict";
  const E=window.GungiEngine,AI=window.GungiAI,S=window.GungiSearch,T=window.GungiTraining;
  if(!E||!AI||!S||!T) throw new Error("Engine, evaluator, search and training must load before tournament.");
  const INITIAL=Object.freeze({material:1,hand:1,position:1,activity:1,mobility:1,threats:1,exposure:1,kingSafety:1});
  const CHAMPION_KEY="gungi-ai-champion-weights-v1";
  const STATS_KEY="gungi-ai-tournament-stats-v1";
  const other=side=>side==="先手"?"後手":"先手";
  const clone=S.cloneState;
  const featureKeys=Object.keys(INITIAL);
  function normalize(weights){
    const result={};
    for(const key of featureKeys){
      const n=Number(weights&&weights[key]);
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
    try{localStorage.setItem(CHAMPION_KEY,JSON.stringify({weights,updatedAt:new Date().toISOString()}));}catch(_){}
  }
  function readStats(candidate){
    try{
      const saved=JSON.parse(localStorage.getItem(STATS_KEY)||"null");
      if(saved&&saved.fingerprint===fingerprint(candidate))return saved;
    }catch(_){}
    return {fingerprint:fingerprint(candidate),games:0,candidateWins:0,championWins:0,draws:0,adjudicated:0,pairs:0,nodes:0,plies:0};
  }
  function saveStats(stats){try{localStorage.setItem(STATS_KEY,JSON.stringify(stats));}catch(_){}}
  function wilsonBounds(rate,n){
    if(!n)return {lower:0,upper:1};
    const z=1.96,z2=z*z,den=1+z2/n;
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
    let adjudicated=false,adjudicationScore=null;
    if(state.phase!=="finished"){
      // Use a fixed referee evaluator so neither competing weight set judges itself.
      AI.setWeights(INITIAL);
      adjudicationScore=AI.evaluate(state,"先手");
      adjudicated=true;
      const margin=250;
      if(adjudicationScore>margin)state.winner="先手";
      else if(adjudicationScore< -margin)state.winner="後手";
    }
    return {
      winner:state.winner,plies:Math.min(plies+1,settings.maxPlies),nodes,
      draw:!state.winner,adjudicated,adjudicationScore
    };
  }
  async function compare(options={}){
    const pairsPerBatch=Math.max(1,Math.min(5,Number(options.pairs)||2));
    const settings={
      maxPlies:Math.max(20,Math.min(120,Number(options.maxPlies)||72)),
      maxDepth:Math.max(1,Math.min(3,Number(options.maxDepth)||2)),
      timeMs:Math.max(60,Math.min(500,Number(options.timeMs)||110)),
      maxNodes:Math.max(300,Math.min(5000,Number(options.maxNodes)||1100)),
      maxDeployCandidates:Math.max(2,Math.min(6,Number(options.maxDeployCandidates)||3))
    };
    const candidate=normalize(AI.getWeights()),original=AI.getWeights();
    let champion=readChampion();
    if(fingerprint(candidate)===fingerprint(champion)){
      return {alreadyChampion:true,games:0,scoreRate:1,championWeights:champion,candidateWeights:candidate};
    }
    const totals=readStats(candidate);
    totals.adjudicated=Number(totals.adjudicated)||0;
    const run={candidateWins:0,championWins:0,draws:0,games:0,nodes:0,plies:0,adjudicated:0};
    let promoted=false,rejected=false,stopped=false;
    try{
      // Continue in paired batches until the 95% confidence interval separates
      // from 50%, or the user explicitly requests a stop.
      while(!promoted&&!rejected&&!stopped){
        for(let pair=0;pair<pairsPerBatch;pair++){
          if(options.shouldStop&&options.shouldStop()){stopped=true;break;}
          const pairNumber=totals.pairs+1;
          const start=T.makeStartPosition();
          const first=await playOne(start,"後手",candidate,champion,settings,p=>options.onProgress&&options.onProgress({...p,pair:pairNumber,game:1,totalGames:totals.games}));
          const second=await playOne(start,"先手",candidate,champion,settings,p=>options.onProgress&&options.onProgress({...p,pair:pairNumber,game:2,totalGames:totals.games}));
          for(const [result,candidateSide] of [[first,"後手"],[second,"先手"]]){
            const candidateWon=!result.draw&&result.winner===candidateSide;
            const championWon=!result.draw&&!candidateWon;
            totals.games++;totals.nodes+=result.nodes;totals.plies+=result.plies;
            run.games++;run.nodes+=result.nodes;run.plies+=result.plies;
            if(result.adjudicated){totals.adjudicated++;run.adjudicated++;}
            if(result.draw){totals.draws++;run.draws++;}
            else if(candidateWon){totals.candidateWins++;run.candidateWins++;}
            else{totals.championWins++;run.championWins++;}
          }
          totals.pairs++;
          saveStats(totals);
          const score=totals.candidateWins+totals.draws*.5;
          const scoreRate=score/totals.games;
          const bounds=wilsonBounds(scoreRate,totals.games);
          if(totals.games>=40&&bounds.lower>.5){
            saveChampion(candidate);champion=candidate;promoted=true;
            try{localStorage.removeItem(STATS_KEY);}catch(_){}
          }else if(totals.games>=40&&bounds.upper<.5){
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
            scoreRate,lowerBound:bounds.lower,upperBound:bounds.upper,
            promoted,rejected
          });
          if(promoted||rejected)break;
        }
        if(!stopped&&!promoted&&!rejected&&options.onProgress){
          const score=totals.candidateWins+totals.draws*.5;
          const bounds=wilsonBounds(score/totals.games,totals.games);
          options.onProgress({phase:"continuing",totalGames:totals.games,scoreRate:score/totals.games,lowerBound:bounds.lower,upperBound:bounds.upper});
        }
      }
      const score=totals.candidateWins+totals.draws*.5;
      const scoreRate=totals.games?score/totals.games:0;
      const bounds=wilsonBounds(scoreRate,totals.games);
      return {
        ...run,totalGames:totals.games,totalCandidateWins:totals.candidateWins,
        totalChampionWins:totals.championWins,totalDraws:totals.draws,
        totalAdjudicated:totals.adjudicated,scoreRate,lowerBound:bounds.lower,upperBound:bounds.upper,
        promoted,rejected,stopped,candidateWeights:candidate,championWeights:champion,settings
      };
    } finally {if(!promoted&&!rejected)AI.setWeights(original);}
  }
  window.GungiTournament=Object.freeze({compare,baselineWeights:readChampion,championWeights:readChampion});
})();