import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = {};
const context = vm.createContext({
  self,
  window: self,
  console,
  Date,
  Math,
  Map,
  Set,
  Object,
  Array,
  Number,
  String,
  Boolean,
  JSON,
  Promise,
  Error,
  TypeError,
  performance,
  setTimeout,
  clearTimeout
});

for (const file of [
  "engine-20261107bb.js",
  "evaluation-20261107be.js",
  "search-20261108cycle2.js"
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

const search = self.GungiSearch;
assert.ok(search, "search engine should load");
assert.equal(typeof search.getSearchContextKey, "function", "search context key diagnostic should be exposed");

const emptyBoard = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
const base = {
  board: emptyBoard,
  hands: { "先手": [], "後手": [] },
  turn: "先手",
  history: []
};

function moveEntry(id, index) {
  return {
    type: "move",
    piece: { id },
    from: { row: index % 9, col: (index + 1) % 9 },
    to: { row: (index + 2) % 9, col: (index + 3) % 9 },
    landingMode: "capture",
    positionKey: "not-the-current-position"
  };
}

const historyA = Array.from({ length: 16 }, (_, index) => moveEntry("piece-" + index, index));
const historyB = historyA.map(entry => ({
  ...entry,
  piece: { ...entry.piece },
  from: { ...entry.from },
  to: { ...entry.to }
}));

// This is the 11th most recent history entry: it is outside the old 10-entry
// TT context, but inside the 16-entry window used by antiLoopPenalty().
historyB[5] = moveEntry("different-old-piece", 5);

const keyA = search.getSearchContextKey({ ...base, history: historyA });
const keyB = search.getSearchContextKey({ ...base, history: historyB });
assert.notEqual(
  keyA,
  keyB,
  "transposition keys must differ when any of the last 16 anti-loop-relevant records differ"
);
assert.equal(
  keyA,
  search.getSearchContextKey({ ...base, history: historyA.map(entry => ({
    ...entry,
    piece: { ...entry.piece },
    from: { ...entry.from },
    to: { ...entry.to }
  })) }),
  "equivalent history context should produce the same transposition key"
);


const cycleBoard = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
cycleBoard[4][4].push({ id: "loop-piece", name: "兵", side: "先手" });
const reverseState = {
  board: cycleBoard,
  hands: { "先手": [], "後手": [] },
  turn: "先手",
  history: [{
    type: "move",
    piece: { id: "loop-piece", name: "兵", side: "先手" },
    from: { row: 4, col: 3 },
    to: { row: 4, col: 4 },
    landingMode: "capture",
    positionKey: "not-the-current-position"
  }]
};
const reversePenalty = search.getAntiLoopPenalty(reverseState, {
  type: "move", pieceId: "loop-piece",
  from: { row: 4, col: 4 }, to: { row: 4, col: 3 },
  landingMode: "capture"
});

assert.ok(reversePenalty >= 9000, "immediate reverse moves should receive a strong penalty");

const threeCycleBoard = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
threeCycleBoard[4][6].push({ id: "cycle-piece", name: "弓", side: "先手" });
const threeCycleState = {
  board: threeCycleBoard,
  hands: { "先手": [], "後手": [] },
  turn: "先手",
  history: [
    { type: "move", piece: { id: "cycle-piece" }, from: { row: 4, col: 4 }, to: { row: 4, col: 5 }, positionKey: "p1" },
    { type: "move", piece: { id: "cycle-piece" }, from: { row: 4, col: 5 }, to: { row: 4, col: 6 }, positionKey: "p2" }
  ]
};
const threeCyclePenalty = search.getAntiLoopPenalty(threeCycleState, {
  type: "move", pieceId: "cycle-piece",
  from: { row: 4, col: 6 }, to: { row: 4, col: 4 },
  landingMode: "capture"
});
assert.ok(
  threeCyclePenalty >= 13000,
  "closing a three-square cycle should receive a strong penalty"
);

const repeatedBoardKey = JSON.stringify({
  board: cycleBoard.map(row => row.map(stack => stack.map(piece => piece.side + ":" + piece.name))),
  hands: { "先手": {}, "後手": {} },
  turn: "先手"
});
const repeatedState = {
  board: cycleBoard,
  hands: { "先手": [], "後手": [] },
  turn: "先手",
  history: [{ type: "move", positionKey: repeatedBoardKey }]
};
assert.ok(
  search.getRepeatedPositionPenalty(repeatedState) >= 22000,
  "short repeated positions should receive a decisive cycle penalty"
);

console.log(JSON.stringify({
  success: true,
  test: "history-sensitive transposition key",
  checkedHistoryWindow: 16,
  changedEntryDistanceFromLatest: 11
}, null, 2));
