/* Gungi AI — core data model and verified setup operations. */
(() => {
  "use strict";
  const SIZE = 9;
  const PIECE_COUNTS = Object.freeze({
    "兵": 4, "侍": 2, "砦": 2, "槍": 3, "騎": 2,
    "忍": 2, "弓": 2, "謀": 1, "筒": 1, "砲": 1,
    "少将": 2, "中将": 1, "大将": 1, "帥": 1
  });
  function createEmptyBoard() {
    return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => []));
  }
  function createPiece(name, side, id) {
    if (!Object.prototype.hasOwnProperty.call(PIECE_COUNTS, name)) throw new Error("未知の駒です: " + name);
    if (side !== "先手" && side !== "後手") throw new Error("手番陣営が不正です");
    return Object.freeze({ name, side, id: String(id) });
  }
  function createInventory(side) {
    const inventory = [];
    let id = 1;
    for (const [name, count] of Object.entries(PIECE_COUNTS)) {
      for (let n = 0; n < count; n += 1) inventory.push(createPiece(name, side, id++));
    }
    return inventory;
  }
  function isInside(row, col) {
    return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < SIZE && col >= 0 && col < SIZE;
  }
  function getStack(state, row, col) {
    if (!isInside(row, col)) return null;
    return state.board[row][col];
  }
  function getTopPiece(state, row, col) {
    const stack = getStack(state, row, col);
    return stack && stack.length ? stack[stack.length - 1] : null;
  }
  function isMovablePiece(state, row, col, pieceId) {
    const stack = getStack(state, row, col);
    return !!(stack && stack.length && stack[stack.length - 1].id === String(pieceId));
  }
  function canPlacePiece(state, row, col, piece) {
    if (!isInside(row, col) || !piece || state.phase !== "setup") return false;
    const stack = state.board[row][col];
    if (piece.name === "帥" && stack.length !== 0) return false;
    return true;
  }
  function placePiece(state, row, col, side, pieceId) {
    if (!isInside(row, col) || state.phase !== "setup") return { ok: false, reason: "配置できる局面ではありません。" };
    const hand = state.hands[side];
    if (!hand) return { ok: false, reason: "陣営が不正です。" };
    const index = hand.findIndex(piece => piece.id === String(pieceId));
    if (index < 0) return { ok: false, reason: "その駒は持ち駒にありません。" };
    const piece = hand[index];
    if (!canPlacePiece(state, row, col, piece)) {
      return { ok: false, reason: piece.name === "帥" ? "帥は他の駒があるマスには配置できません。" : "このマスには配置できません。" };
    }
    hand.splice(index, 1);
    state.board[row][col].push(piece);
    state.history.push({ type: "place", row, col, side, piece });
    return { ok: true, piece };
  }
  function removeTopPiece(state, row, col) {
    const stack = getStack(state, row, col);
    if (!stack || !stack.length || state.phase !== "setup") return { ok: false, reason: "取り除ける駒がありません。" };
    const piece = stack.pop();
    state.hands[piece.side].push(piece);
    state.history.push({ type: "remove", row, col, piece });
    return { ok: true, piece };
  }
  function resolveLandingStack(movingPiece, destinationStack) {
    if (!destinationStack.length) return [];
    return destinationStack.every(piece => piece.side !== movingPiece.side) ? [] : destinationStack.slice();
  }
  function createGameState() {
    return {
      board: createEmptyBoard(),
      hands: { "先手": createInventory("先手"), "後手": createInventory("後手") },
      turn: "先手", phase: "setup", moveNumber: 1, history: []
    };
  }
  window.GungiEngine = Object.freeze({
    SIZE, PIECE_COUNTS, createEmptyBoard, createPiece, createInventory, createGameState,
    isInside, getStack, getTopPiece, isMovablePiece, canPlacePiece, placePiece,
    removeTopPiece, resolveLandingStack
  });
})();