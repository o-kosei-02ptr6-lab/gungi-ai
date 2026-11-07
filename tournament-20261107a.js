/* Gungi AI — paired self-play evaluator.
 * Compares the current learned weights against the untrained 1.0 baseline.
 * Each pair reuses one opening position and swaps which side receives each evaluator.
 */
(() => {
  "use strict";
  const E=window.GungiEngine,AI=window.GungiAI,S=window.GungiSearch,T=window.GungiTraining;
  if(!E||!AI||!S||!T) throw new Error("Engine, evaluator, search and training must load before tournament.");
  const BASELINE=Object.freeze({material:1,hand:1,position:1,activity:1,mobility:1,threats:1,exposure:1,kingSafety:1});
  const other=side=>side==="先手"?"後手":"先手";
  const clone=S.cloneState;
  async function playOne(start,candidateSide,weights,options,progress){
    const state=clone(start);
    let nodes=0,plies=0;
    for(;plies<options.maxPlies&&state.phase==="move";plies++){
      const side=state.turn;
      AI.setWeights(side===candidateSide?weights:options.baseline);
      const result=await S.findBestMove(state,{
        maxDepth:options.maxDepth,timeMs:options.timeMs,maxNodes:options.maxNodes,
        maxDeployCandidates:options.maxDeployCandidates
      });
      nodes+=result.nodes||0;
      const action=result.bestMove;
      if(!action){state.phase="finished";state.winner=other(side);break;}
      const applied=action.type==="deploy"
        ?E.deployPiece(state,action.row,action.col,side,action.pieceId)
        :E.movePiece(state,action.from.row,action.from.col,action.to.row,action.to.col,action.landingMode);
      if(!applied||!applied.ok) throw new Error("対局の着手に失敗しました: "+(applied&&applied.reason||"不明なエラー"));
      if(progress) progress({side,plies:plies+1,nodes,phase:"game"});
      if(applied.gameOver) break;
      if(plies%2===1) await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {winner:state.winner,plies:Math.min(plies+1,options.maxPlies),nodes,draw:state.phase!=="finished"};
  }
  async function compare(options={}){
    const pairs=Math.max(1,Math.min(5,Number(options.pairs)||2));
    const settings={
      maxPlies:Math.max(12,Math.min(60,Number(options.maxPlies)||36)),
      maxDepth:Math.max(1,Math.min(3,Number(options.maxDepth)||2)),
      timeMs:Math.max(60,Math.min(500,Number(options.timeMs)||110)),
      maxNodes:Math.max(300,Math.min(5000,Number(options.maxNodes)||1100)),
      maxDeployCandidates:Math.max(2,Math.min(6,Number(options.maxDeployCandidates)||3)),
      baseline:BASELINE
    };
    const candidate=AI.getWeights();
    const original=AI.getWeights();
    const totals={candidateWins:0,baselineWins:0,draws:0,games:0,nodes:0,plies:0};
    try{
      for(let pair=0;pair<pairs;pair++){
        const start=T.makeStartPosition();
        // Same opening, with evaluator assignments swapped to reduce first-player bias.
        const first=await playOne(start,"後手",candidate,settings,p=>options.onProgress&&options.onProgress({...p,pair:pair+1,pairs,game:1}));
        const second=await playOne(start,"先手",candidate,settings,p=>options.onProgress&&options.onProgress({...p,pair:pair+1,pairs,game:2}));
        for(const [result,candidateSide] of [[first,"後手"],[second,"先手"]]){
          totals.games++;totals.nodes+=result.nodes;totals.plies+=result.plies;
          if(result.draw) totals.draws++;
          else if(result.winner===candidateSide) totals.candidateWins++;
          else totals.baselineWins++;
        }
        if(options.onProgress) options.onProgress({phase:"pairDone",pair:pair+1,pairs,...totals});
      }
    } finally { AI.setWeights(original); }
    const score=totals.candidateWins+totals.draws*0.5;
    return {...totals,scoreRate:totals.games?score/totals.games:0,candidateWeights:candidate,baselineWeights:BASELINE,settings};
  }
  window.GungiTournament=Object.freeze({compare,baselineWeights:()=>({...BASELINE})});
})();