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
for (const file of ["engine-20261107bb.js","evaluation-20261107be.js","search-20261108cycle2.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root,file),"utf8"),context,{filename:file});
}
const search=self.GungiSearch;
assert.ok(search,"search engine should load");
assert.equal(typeof search.getSearchContextKey,"function");

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
assert.equal(progress.at(-1).depth,telemetry.depth);

console.log(JSON.stringify({
  success:true,
  tests:["history-sensitive TT key","cycle-length-independent repetition cost","repeat-count escalation","historical retreat diagnostic","Marshal escape exemption","per-search depth and cost telemetry"]
},null,2));
