import fs from "node:fs";
import path from "node:path";
const source=path.resolve("artifacts/server-training-report.json");
const destination=path.resolve("training-data/latest.json");
const report=JSON.parse(fs.readFileSync(source,"utf8"));
if(!Array.isArray(report.results))throw new Error("Training report has no results array.");
function compactBoard(board){
 if(!Array.isArray(board)||board.length!==9)throw new Error("Unexpected board shape.");
 return board.flat().map(stack=>(stack||[]).map(piece=>(piece.side==="先手"?"S":"G")+":"+piece.name).join(","));
}
function compactState(state){
 if(!state||!Array.isArray(state.board))return null;
 return {board:compactBoard(state.board),turn:state.turn,phase:state.phase,moveNumber:state.moveNumber,winner:state.winner||null};
}
const results=report.results.map(game=>({
 game:game.game,candidateSide:game.candidateSide,winner:game.winner||null,draw:!!game.draw,
 plies:game.plies,searchDepth:game.searchDepth||0,repeatedPositionVisits:game.repeatedPositionVisits||0,
 setupDiagnostics:game.setupDiagnostics||{},startState:compactState(game.startState),
 positionSamples:(game.positionSamples||[]).filter(p=>Array.isArray(p.board)).map(p=>({
  ply:p.ply,turn:p.turn,board:compactBoard(p.board),
  search:p.search?{completedDepth:p.search.completedDepth,selectedMove:p.search.selectedMove}:null
 })),
 finalState:compactState(game.finalState)
}));
const payload={format:"gungi-training-replay",version:1,runId:process.env.GITHUB_RUN_ID||null,
 publishedAt:new Date().toISOString(),gamesThisRun:report.gamesThisRun,totalGames:report.totalGames,
 searchProfile:report.searchProfile,results};
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify(payload));
console.log("Published latest replay:",results.length,"games,",fs.statSync(destination).size,"bytes.");
