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

// 王手中でも、王手を放置して同じ駒を往復させる手には反復罰則を適用する。
// 一方、帥自身が安全地帯へ逃げる逆戻りは罰則の対象にしない。
const checkedBoard = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => []));
checkedBoard[8][4].push({ id: "checked-marshal", name: "帥", side: "先手" });
checkedBoard[6][4].push({ id: "checking-knight", name: "騎", side: "後手" });
checkedBoard[4][4].push({ id: "looping-general", name: "少将", side: "先手" });
const checkedLoopState = {
  board: checkedBoard,
  hands: { "先手": [], "後手": [] },
  turn: "先手",
  history: [{
    type: "move",
    piece: { id: "looping-general", name: "少将", side: "先手" },
    from: { row: 4, col: 3 },
    to: { row: 4, col: 4 },
    landingMode: "capture",
    positionKey: "old-position"
  }]
};
assert.equal(context.window.GungiEngine.isInCheck(checkedLoopState, "先手"), true,
  "the regression position must begin in check");
const unresolvedCheckPenalty = search.getAntiLoopPenalty(checkedLoopState, {
  type: "move", pieceId: "looping-general",
  from: { row: 4, col: 4 }, to: { row: 4, col: 3 },
  landingMode: "capture"
});
assert.ok(unresolvedCheckPenalty >= 9000,
  "an oscillating move that leaves the Marshal in check should be penalized");

const marshalEscapeState = {
  board: checkedBoard.map(row => row.map(stack => stack.slice())),
  hands: { "先手": [], "後手": [] },
  turn: "先手",
  history: [{
    type: "move",
    piece: { id: "checked-marshal", name: "帥", side: "先手" },
    from: { row: 8, col: 3 },
    to: { row: 8, col: 4 },
    landingMode: "capture",
    positionKey: "old-position"
  }]
};
const marshalEscapePenalty = search.getAntiLoopPenalty(marshalEscapeState, {
  type: "move", pieceId: "checked-marshal",
  from: { row: 8, col: 4 }, to: { row: 8, col: 3 },
  landingMode: "capture"
});
assert.ok(marshalEscapePenalty > 0 && marshalEscapePenalty < 9000,
  "a repeated check-evasion move should retain priority but receive a reduced penalty when another safe response exists");

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
