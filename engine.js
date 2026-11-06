/* Gungi AI — core data model.
 * Movement patterns are intentionally kept separate until each official
 * piece movement rule has been verified.
 */
(() => {
  "use strict";

  const SIZE = 9;

  // Physical inventory per player. Counts supplied for this project.
  const PIECE_COUNTS = Object.freeze({
    "兵": 4, "侍": 2, "砦": 2, "槍": 3, "騎": 2,
    "忍": 2, "弓": 2, "謀": 1, "筒": 1, "砲": 1,
    "少将": 2, "中将": 1, "大将": 1, "帥": 1
  });

  function createEmptyBoard() {
    return Array.from({ length: SIZE }, () =>
      Array.from({ length: SIZE }, () => [])
    );
  }

  function createPiece(name, side, id) {
    if (!(name in PIECE_COUNTS)) throw new Error("未知の駒です: " + name);
    if (side !== "先手" && side !== "後手") throw new Error("手番陣営が不正です");
    return Object.freeze({ name, side, id: String(id) });
  }

  function createInventory(side) {
    const inventory = [];
    let id = 1;
    for (const [name, count] of Object.entries(PIECE_COUNTS)) {
      for (let n = 0; n < count; n += 1) {
        inventory.push(createPiece(name, side, id++));
      }
    }
    return inventory;
  }

  function isInside(row, col) {
    return Number.isInteger(row) && Number.isInteger(col) &&
      row >= 0 && row < SIZE && col >= 0 && col < SIZE;
  }

  function getStack(state, row, col) {
    if (!isInside(row, col)) return null;
    return state.board[row][col];
  }

  function getTopPiece(state, row, col) {
    const stack = getStack(state, row, col);
    return stack && stack.length ? stack[stack.length - 1] : null;
  }

  // A piece covered by another piece cannot move.
  function isMovablePiece(state, row, col, pieceId) {
    const stack = getStack(state, row, col);
    if (!stack || !stack.length) return false;
    const top = stack[stack.length - 1];
    return top.id === String(pieceId);
  }

  // A 帥 may not be placed on another piece during setup.
  function canPlacePiece(state, row, col, piece) {
    if (!isInside(row, col) || !piece) return false;
    const stack = state.board[row][col];
    if (piece.name === "帥" && stack.length !== 0) return false;
    return true;
  }

  // The supplied rule: a stack made entirely of enemy pieces is captured
  // when an opposing piece lands on that square.
  function resolveLandingStack(movingPiece, destinationStack) {
    if (!destinationStack.length) return [];
    const allEnemy = destinationStack.every(
      piece => piece.side !== movingPiece.side
    );
    return allEnemy ? [] : destinationStack.slice();
  }

  function createGameState() {
    return {
      board: createEmptyBoard(),
      hands: {
        "先手": createInventory("先手"),
        "後手": createInventory("後手")
      },
      turn: "先手",
      phase: "setup",
      moveNumber: 1,
      history: []
    };
  }

  window.GungiEngine = Object.freeze({
    SIZE,
    PIECE_COUNTS,
    createEmptyBoard,
    createPiece,
    createInventory,
    createGameState,
    isInside,
    getStack,
    getTopPiece,
    isMovablePiece,
    canPlacePiece,
    resolveLandingStack
  });
})();
