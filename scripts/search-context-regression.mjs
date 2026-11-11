import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = {};
const context = vm.createContext({
  self, window: self, console, Date, Math, Map, Set, Object, Array, Number,
  String, Boolean, JSON, Promise, Error, TypeError, performance, setTimeout, clearTimeout
});
for (const file of ["engine-20261107bb.js","evaluation-20261107be.js","search-20261108cycle3.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root,file),"utf8"),context,{filename:file});
}
const search=self.GungiSearch;
const evaluator=self.GungiAI;
assert.ok(search,"search engine should load");
assert.equal(typeof search.getSearchContextKey,"function");

// A cloned but position-identical state should reuse the exact evaluation.
const cacheProbe=self.GungiEngine.createGameState();
const cacheBefore=evaluator.getEvaluationCacheStats().hits;
const cacheScoreA=evaluator.evaluate(cacheProbe,"先手");
const cacheScoreB=evaluator.evaluate(search.cloneState(cacheProbe),"先手");
assert.equal(cacheScoreA,cacheScoreB,"position cache must preserve the exact evaluation score");
assert.ok(evaluator.getEvaluationCacheStats().hits>cacheBefore,
  "cloned identical positions should hit the shared evaluation cache");
const marshal=cacheProbe.hands["先手"].find(piece=>piece.name==="帥");
assert.ok(self.GungiEngine.placePiece(cacheProbe,8,4,"先手",marshal.id).ok,
  "cache probe should mutate through a legal Marshal placement");
const mutatedScore=evaluator.evaluate(cacheProbe,"先手");
const mutatedCloneScore=evaluator.evaluate(search.cloneState(cacheProbe),"先手");
assert.equal(mutatedScore,mutatedCloneScore,
  "mutating a state object must invalidate its object-identity evaluation cache");
assert.notEqual(mutatedScore,cacheScoreA,
  "a changed board must not reuse the previous position's evaluation");

// Setup search must honor the mandatory Marshal-first rule for both sides,
// preserve the front-row-only Marshal square, and return executable placements.
const engine=self.GungiEngine;
function putFixturePiece(state,row,col,name,side,id){
  const piece=engine.createPiece(name,side,id);
  if(name==="帥"){
    const index=state.hands[side].findIndex(item=>item.name==="帥");
    if(index>=0)state.hands[side].splice(index,1);
  }
  state.board[row][col].push(piece);
  return piece;
}

// A checked side may not make an unrelated move or deploy. A reserve deployment
// that blocks the checking ray is accepted as a legal evasion.
const forcedCheck=engine.createGameState();
forcedCheck.phase="move";
putFixturePiece(forcedCheck,8,4,"帥","先手","check-s");
forcedCheck.board[4][4].push(engine.createPiece("大将","後手","check-g"));
forcedCheck.board[8][3].push(engine.createPiece("兵","先手","check-p"));
forcedCheck.turn="先手";
assert.equal(engine.isInCheck(forcedCheck,"先手"),true,"test position should begin in check");
const illegalCheckMove=engine.movePiece(forcedCheck,8,3,7,3,"capture");
assert.equal(illegalCheckMove.ok,false,"an unrelated move must be rejected while in check");
const reservePawn=forcedCheck.hands["先手"].find(piece=>piece.name==="兵");
const illegalCheckDeploy=engine.deployPiece(forcedCheck,6,5,"先手",reservePawn.id);
assert.equal(illegalCheckDeploy.ok,false,"a deployment that leaves the checking ray open must be rejected");
const legalCheckDeploy=engine.deployPiece(forcedCheck,6,4,"先手",reservePawn.id);
assert.equal(legalCheckDeploy.ok,true,"a reserve deployment that blocks the checking ray must be accepted");
assert.equal(engine.isInCheck(forcedCheck,"先手"),false,"the accepted deployment must actually resolve check");
// A checked side's search list must contain only moves that actually resolve check.
const searchCheck=engine.createGameState();
searchCheck.phase="move";
putFixturePiece(searchCheck,8,4,"帥","先手","search-check-s");
searchCheck.board[4][4].push(engine.createPiece("大将","後手","search-check-g"));
searchCheck.board[8][3].push(engine.createPiece("兵","先手","search-check-p"));
searchCheck.turn="先手";
const forcedActions=search.getSearchActions(searchCheck,{maxDeployCandidates:12});
assert.ok(forcedActions.length>0,"the checked side should have at least one genuine evasion");
for(const action of forcedActions){
  const trial=search.cloneState(searchCheck);
  const applied=action.type==="deploy"
    ? engine.deployPiece(trial,action.row,action.col,"先手",action.pieceId)
    : engine.movePiece(trial,action.from.row,action.from.col,action.to.row,action.to.col,action.landingMode);
  assert.ok(applied.ok,"every search action while checked must be executable");
  assert.equal(trial.phase==="finished"&&trial.winner==="先手" ? false : engine.isInCheck(trial,"先手"),false,
    "every search action while checked must resolve check or win by capturing the opposing Marshal");
}

// A Marshal may escape to a safe adjacent square.
const escapeState=engine.createGameState();
escapeState.phase="move";
putFixturePiece(escapeState,8,4,"帥","先手","escape-s");
escapeState.board[4][4].push(engine.createPiece("大将","後手","escape-g"));
escapeState.turn="先手";
assert.equal(engine.isInCheck(escapeState,"先手"),true);
assert.ok(engine.movePiece(escapeState,8,4,8,3,"capture").ok,
  "a Marshal escape that leaves the checking ray must be accepted");
assert.equal(engine.isInCheck(escapeState,"先手"),false);

// Capturing the checking piece is a valid evasion.
const captureCheck=engine.createGameState();
captureCheck.phase="move";
putFixturePiece(captureCheck,8,4,"帥","先手","capture-s");
captureCheck.board[7][4].push(engine.createPiece("大将","後手","capture-g"));
captureCheck.turn="先手";
assert.equal(engine.isInCheck(captureCheck,"先手"),true);
assert.ok(engine.movePiece(captureCheck,8,4,7,4,"capture").ok,
  "capturing the checking piece must be accepted");
assert.equal(engine.isInCheck(captureCheck,"先手"),false);

// The Marshal may also neutralize a checking piece by stacking onto it,
// when the stack-height rule prevents that piece from recapturing.
const tsukeCheck=engine.createGameState();
tsukeCheck.phase="move";
putFixturePiece(tsukeCheck,8,4,"帥","先手","tsuke-s");
tsukeCheck.board[7][4].push(engine.createPiece("大将","後手","tsuke-g"));
tsukeCheck.turn="先手";
assert.equal(engine.isInCheck(tsukeCheck,"先手"),true);
assert.ok(engine.movePiece(tsukeCheck,8,4,7,4,"tsuke").ok,
  "stacking the Marshal onto a checking piece must be accepted when legal");
assert.equal(engine.isInCheck(tsukeCheck,"先手"),false,
  "the stack-height rule should prevent the covered checker from attacking back");

// A friendly move that interposes on a long checking ray is a valid evasion.
const interposeState=engine.createGameState();
interposeState.phase="move";
putFixturePiece(interposeState,8,4,"帥","先手","interpose-s");
interposeState.board[4][4].push(engine.createPiece("大将","後手","interpose-g"));
interposeState.board[6][3].push(engine.createPiece("大将","先手","interpose-blocker"));
interposeState.turn="先手";
assert.equal(engine.isInCheck(interposeState,"先手"),true);
assert.ok(engine.movePiece(interposeState,6,3,6,4,"capture").ok,
  "moving a friendly piece onto the checking ray must be accepted");
assert.equal(engine.isInCheck(interposeState,"先手"),false);

// A boxed-in Marshal with every adjacent capture square defended is checkmated.
const mateState=engine.createGameState();
mateState.phase="move";
putFixturePiece(mateState,8,4,"帥","先手","mate-s");
mateState.board[7][4].push(engine.createPiece("兵","後手","mate-checker-base"));
mateState.board[7][4].push(engine.createPiece("大将","後手","mate-checker"));
mateState.board[6][4].push(engine.createPiece("兵","後手","mate-guard-base"));
mateState.board[6][4].push(engine.createPiece("大将","後手","mate-guard"));
for(const [row,col,id] of [[7,3,"mate-left"],[7,5,"mate-right"],[8,3,"mate-back-left"],[8,5,"mate-back-right"]]){
  mateState.board[row][col].push(engine.createPiece("兵","後手",id+"-base"));
  mateState.board[row][col].push(engine.createPiece("兵","後手",id));
}
mateState.turn="先手";
assert.equal(engine.isInCheck(mateState,"先手"),true,"boxed Marshal must be in check");
assert.equal(engine.hasLegalCheckEvasion(mateState,"先手"),false,
  "all Marshal escapes and captures should be defended and no block should exist");
assert.equal(engine.finishIfCheckmate(mateState,"先手","後手"),true,
  "no legal check evasion must trigger immediate checkmate");
assert.equal(mateState.phase,"finished");
assert.equal(mateState.winner,"後手");

// The move that creates an unavoidable check must end the game immediately.
const instantMate=engine.createGameState();
instantMate.phase="move";
putFixturePiece(instantMate,8,4,"帥","先手","instant-mate-s");
putFixturePiece(instantMate,6,4,"兵","後手","instant-mate-checker");
putFixturePiece(instantMate,5,4,"兵","後手","instant-mate-guard-base");
putFixturePiece(instantMate,5,4,"大将","後手","instant-mate-guard");
for(const [row,col,id] of [[7,3,"im-left"],[7,5,"im-right"],[8,3,"im-back-left"],[8,5,"im-back-right"]]){
  putFixturePiece(instantMate,row,col,"兵","後手",id+"-base");
  putFixturePiece(instantMate,row,col,"兵","後手",id);
}
for(const [row,col,id] of [[6,3,"im-def-left"],[6,5,"im-def-right"],[7,2,"im-def-back-left"],[7,6,"im-def-back-right"]]){
  putFixturePiece(instantMate,row,col,"兵","後手",id+"-base");
  putFixturePiece(instantMate,row,col,"大将","後手",id);
}
instantMate.turn="後手";
assert.equal(engine.isInCheck(instantMate,"先手"),false,
  "the Marshal must not already be in check before the mating move");
const matingMove=engine.movePiece(instantMate,6,4,7,4,"capture");
assert.equal(matingMove.ok,true,"the checking pawn's move should be legal");
assert.equal(matingMove.gameOver,true,"an unavoidable check must end the game on the checking move");
assert.equal(matingMove.checkmate,true,"the result must be identified as checkmate");
assert.equal(matingMove.winner,"後手");
assert.equal(instantMate.phase,"finished");
assert.equal(instantMate.winner,"後手");

const setupState=engine.createGameState();
const firstSetup=await search.findBestSetupPlacement(setupState,{
  timeMs:100,maxNodes:100,allowFinish:false,requireNoCheckBoth:true
});
assert.ok(firstSetup.bestMove,"setup search should return a legal first-side placement");
assert.equal(firstSetup.bestMove.pieceName,"帥");
assert.equal(firstSetup.bestMove.row,engine.SIZE-1);
const firstPlacement=engine.placePiece(setupState,firstSetup.bestMove.row,
  firstSetup.bestMove.col,"先手",firstSetup.bestMove.pieceId);
assert.ok(firstPlacement.ok,"first Marshal placement should execute");
const secondSetup=await search.findBestSetupPlacement(setupState,{
  timeMs:100,maxNodes:100,allowFinish:false,requireNoCheckBoth:true
});
assert.ok(secondSetup.bestMove,"setup search should return a legal second-side placement");
assert.equal(secondSetup.bestMove.pieceName,"帥");
assert.equal(secondSetup.bestMove.row,0);
const secondPlacement=engine.placePiece(setupState,secondSetup.bestMove.row,
  secondSetup.bestMove.col,"後手",secondSetup.bestMove.pieceId);
assert.ok(secondPlacement.ok,"second Marshal placement should execute");
assert.equal(setupState.setupTurn,"先手","alternating setup order should be preserved");
const thirdSetup=await search.findBestSetupPlacement(setupState,{
  timeMs:100,maxNodes:100,allowFinish:true,requireNoCheckBoth:true
});
assert.ok(thirdSetup.bestMove,"setup search should continue after both Marshals are placed");
if(thirdSetup.finishRecommended){
  assert.ok(engine.finishSetup(setupState,setupState.setupTurn).ok,
    "search-recommended finish should be accepted by the engine");
}
assert.ok(engine.placePiece(setupState,thirdSetup.bestMove.row,thirdSetup.bestMove.col,
  setupState.setupTurn,thirdSetup.bestMove.pieceId).ok,
  "searched setup placement should execute after an optional finish");

const empty=()=>Array.from({length:9},()=>Array.from({length:9},()=>[]));
const base={board:empty(),hands:{"先手":[],"後手":[]},turn:"先手",history:[]};
const entry=(id,index)=>({type:"move",piece:{id},from:{row:index%9,col:(index+1)%9},to:{row:(index+2)%9,col:(index+3)%9},landingMode:"capture",positionKey:"unrelated"});
const historyA=Array.from({length:16},(_,i)=>entry("p"+i,i));
const historyB=historyA.map(x=>({...x,piece:{...x.piece},from:{...x.from},to:{...x.to}}));
historyB[5]=entry("different-piece",5);
assert.notEqual(search.getSearchContextKey({...base,history:historyA}),search.getSearchContextKey({...base,history:historyB}),
  "TT keys must preserve all 16 anti-loop-relevant history records");
assert.equal(search.getSearchContextKey({...base,history:historyA}),
  search.getSearchContextKey({...base,history:historyA.map(x=>({...x,piece:{...x.piece},from:{...x.from},to:{...x.to}}))}));

const board=empty();
board[4][4].push({id:"loop-piece",name:"兵",side:"先手"});
const repetitionKey=JSON.stringify({
  board:board.map(row=>row.map(stack=>stack.map(piece=>piece.side+":"+piece.name))),
  hands:{"先手":{},"後手":{}},turn:"先手"
});
const oneRepeat={board,hands:{"先手":[],"後手":[]},turn:"先手",
  history:[{type:"move",positionKey:repetitionKey}]};
const twoRepeats={...oneRepeat,history:[...oneRepeat.history,{type:"move",positionKey:repetitionKey}]};
assert.equal(search.getRepeatedPositionPenalty(oneRepeat),260,
  "every repeated position should receive the same base cost regardless of cycle length");
assert.equal(search.getRepeatedPositionPenalty(twoRepeats),440,
  "the cost should rise with repeat count, not with a 4/8/12-ply category");
assert.equal(search.isThreefoldRepetition(oneRepeat),false,
  "the first revisit must remain searchable");
assert.equal(search.isThreefoldRepetition(twoRepeats),true,
  "the third occurrence must be recognized as a repetition draw");

const progressBoard=empty();
progressBoard[5][4].push({id:"advancing-piece",name:"槍",side:"先手"});
const progressState={board:progressBoard,hands:{"先手":[],"後手":[]},turn:"先手",history:[{
  type:"move",piece:{id:"advancing-piece",name:"槍",side:"先手"},
  from:{row:7,col:4},to:{row:5,col:4},positionKey:"older-position"
}]};
assert.equal(search.getHistoricalRetreatPenalty(progressState,{
  type:"move",pieceId:"advancing-piece",from:{row:5,col:4},to:{row:6,col:4},landingMode:"capture"
}),40);
assert.equal(search.getHistoricalRetreatPenalty(progressState,{
  type:"move",pieceId:"advancing-piece",from:{row:5,col:4},to:{row:4,col:4},landingMode:"capture"
}),0);

const marshalBoard=empty();
marshalBoard[5][4].push({id:"marshal-progress",name:"帥",side:"先手"});
assert.equal(search.getHistoricalRetreatPenalty({board:marshalBoard,history:progressState.history},{
  type:"move",pieceId:"marshal-progress",from:{row:5,col:4},to:{row:6,col:4},landingMode:"capture"
}),0,"Marshal escapes must not be discouraged by retreat history");

// The search API must expose real completed-depth and cost metrics for each move.
const telemetryBoard=empty();
telemetryBoard[8][4].push({id:"first-marshal",name:"帥",side:"先手"});
telemetryBoard[0][4].push({id:"second-marshal",name:"帥",side:"後手"});
const telemetryState={...base,board:telemetryBoard,phase:"move",winner:null,moveNumber:1};
const progress=[];
const telemetry=await search.findBestMove(telemetryState,{
  maxDepth:1,timeMs:300,maxNodes:5000,maxDeployCandidates:0,
  onProgress:item=>progress.push(item)
});
assert.ok(telemetry.bestMove,"telemetry smoke position should produce a legal move");
for(const key of ["depth","nodes","quiescenceNodes","cutoffs","transpositionHits","elapsedMs"])
  assert.ok(Number.isFinite(telemetry[key]),"search result should expose "+key);
assert.ok(progress.length>0,"iterative-deepening progress should be observable");
assert.ok(telemetry.quiescenceDiagnostics &&
  Number.isFinite(telemetry.quiescenceDiagnostics.adaptiveQuietStops),
  "quiescence diagnostics should expose adaptive quiet-position stops");
assert.equal(progress.at(-1).depth,telemetry.depth);
assert.ok(telemetry.rootCandidates.length>0 && telemetry.rootCandidates.length<=5,
  "completed searches should preserve up to five root candidates");
assert.equal(telemetry.rootCandidateSource,"search",
  "completed-depth candidate scores should be labeled as search scores");

// Force an intentionally tiny budget: even when no iteration completes, the
// engine must retain a separate static-evaluation shortlist for diagnostics.
const fallbackTelemetry=await search.findBestMove(telemetryState,{
  maxDepth:8,timeMs:100,maxNodes:1000,maxDeployCandidates:0
});
assert.ok(fallbackTelemetry.bestMove,"fallback search should still return a legal move");
assert.ok(fallbackTelemetry.rootCandidates.length>0 && fallbackTelemetry.rootCandidates.length<=5,
  "depth-zero searches should still expose a candidate shortlist");
assert.ok(["search","static-fallback"].includes(fallbackTelemetry.rootCandidateSource),
  "candidate scores must identify whether they came from search or static fallback");
if (fallbackTelemetry.depth === 0) {
  assert.equal(fallbackTelemetry.rootCandidateSource,"static-fallback",
    "depth-zero candidate scores must be labeled as static fallback scores");
} else {
  assert.equal(fallbackTelemetry.rootCandidateSource,"search",
    "completed-depth candidate scores must be labeled as search scores");
}

console.log(JSON.stringify({
  success:true,
  tests:["history-sensitive TT key","cycle-length-independent repetition cost","repeat-count escalation","historical retreat diagnostic","Marshal escape exemption","forced check-only search actions","Marshal escape","capture checking piece","Marshal tsuke onto checker","interpose by moving a friendly piece","immediate checkmate with all evasions covered","instant checkmate after the checking move","deployment interposition","per-search depth and cost telemetry","root candidate shortlist after timeout","candidate score source labeling"]
},null,2));
