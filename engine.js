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
    // Upper/intermediate setup permits the 帥 itself to be placed on a
    // friendly stack, but no piece may be placed on top of an existing 帥.
    if (stack.length && stack[stack.length - 1].name === "帥") return false;
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
  function resolveLandingStack(movingPiece, destinationStack) {
    // When the destination's top piece is an enemy, remove all enemy pieces
    // while preserving friendly pieces in a mixed stack.
    return destinationStack.filter(piece => piece.side === movingPiece.side);
  }

  // Movement vectors use (forward, right). Forward is rotated by side.
  // Each entry lists destinations added at that stack level.
  const MOVE_RULES = Object.freeze({
    "帥": {1:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],2:[[2,0],[-2,0],[0,2],[0,-2],[2,2],[2,-2],[-2,2],[-2,-2]],3:[[3,0],[-3,0],[0,3],[0,-3],[3,3],[3,-3],[-3,3],[-3,-3]]},
    "大将": {1:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],2:[[2,2],[2,-2],[-2,2],[-2,-2]],3:[[3,3],[3,-3],[-3,3],[-3,-3]],rays:[[1,0],[-1,0],[0,1],[0,-1]]},
    "中将": {1:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],2:[[2,2],[2,-2],[-2,2],[-2,-2]],3:[[3,3],[3,-3],[-3,3],[-3,-3]],rays:[[1,1],[1,-1],[-1,1],[-1,-1]]},
    "少将": {1:[[1,0],[1,1],[1,-1],[0,1],[0,-1],[-1,0]],2:[[2,1],[2,-1],[0,2],[0,-2]],3:[[3,0],[3,2],[3,-2],[0,3],[0,-3]]},
    "侍": {1:[[1,0],[1,1],[1,-1],[-1,0]],2:[[2,0],[2,2],[2,-2]],3:[[3,0],[3,3],[3,-3]]},
    "槍": {1:[[1,0],[1,1],[1,-1],[-1,0],[2,0]],2:[[2,1],[2,-1],[3,0]],3:[[3,1],[3,-1],[4,0]]},
    "騎": {1:[[1,0],[-1,0],[2,0],[-2,0],[0,1],[0,-1]],2:[[3,0],[-3,0],[0,2],[0,-2]],3:[[4,0],[-4,0],[0,3],[0,-3]]},
    "忍": {1:[[1,1],[1,-1],[-1,1],[-1,-1],[2,2],[2,-2],[-2,2],[-2,-2]],2:[[3,3],[3,-3],[-3,3],[-3,-3]],3:[[4,4],[4,-4],[-4,4],[-4,-4]]},
    "砦": {1:[[1,0],[0,1],[0,-1],[-1,1],[-1,-1]],2:[[2,0],[0,2],[0,-2],[-2,2],[-2,-2]],3:[[3,0],[0,3],[0,-3],[-3,3],[-3,-3]]},
    "兵": {1:[[1,0],[-1,0]],2:[[2,0]],3:[[3,0]]},
    "砲": {1:[[3,0],[0,1],[0,-1],[-1,0]],2:[[4,0],[0,2],[0,-2]],3:[[5,0],[0,3],[0,-3]],jumps:[[3,0],[4,0],[5,0]]},
    "弓": {1:[[2,0],[2,1],[2,-1],[-1,0]],2:[[3,0],[3,1],[3,-1]],3:[[4,0],[4,1],[4,-1]],jumps:[[2,0],[2,1],[2,-1],[3,0],[3,1],[3,-1],[4,0],[4,1],[4,-1]]},
    "筒": {1:[[2,0],[-1,1],[-1,-1]],2:[[3,0],[-2,2],[-2,-2]],3:[[4,0],[-3,3],[-3,-3]],jumps:[[2,0],[3,0],[4,0]]},
    "謀": {1:[[1,1],[1,-1],[-1,0]],2:[[2,2],[2,-2],[-2,0]],3:[[3,3],[3,-3],[-3,0]]}
  });
  function rotateVector(forward, right, side) {
    return side === "先手" ? [-forward, right] : [forward, right];
  }
  function getMovementTargets(state, row, col) {
    const stack = getStack(state, row, col);
    if (!stack || !stack.length || stack.length > 3) return [];
    const piece = stack[stack.length - 1];
    const level = stack.length;
    const rule = MOVE_RULES[piece.name];
    if (!rule) return [];
    const vectors = [...rule[1], ...(level >= 2 ? rule[2] : []), ...(level >= 3 ? rule[3] : [])];
    const targets = [];
    const seen = new Set();
    for (const [f, r] of vectors) {
      const [dr, dc] = rotateVector(f, r, piece.side);
      const tr = row + dr, tc = col + dc;
      if (!isInside(tr, tc)) continue;
      const key = tr + "," + tc;
      if (!seen.has(key)) { seen.add(key); targets.push({ row: tr, col: tc, jump: (rule.jumps || []).some(v => v[0] === f && v[1] === r) }); }
    }
    for (const [f, r] of (rule.rays || [])) {
      const [dr, dc] = rotateVector(f, r, piece.side);
      let tr = row + dr, tc = col + dc;
      while (isInside(tr, tc)) {
        const key = tr + "," + tc;
        if (!seen.has(key)) { seen.add(key); targets.push({ row: tr, col: tc, jump: false, ray: true }); }
        const blocking = getTopPiece(state, tr, tc);
        if (blocking) break;
        tr += dr; tc += dc;
      }
    }
    return targets;
  }
  function canMoveTo(state, fromRow, fromCol, toRow, toCol) {
    if (!isInside(toRow, toCol) || (fromRow === toRow && fromCol === toCol)) return false;
    const source = getStack(state, fromRow, fromCol);
    if (!source || !source.length || source.length > 3) return false;
    const moving = source[source.length - 1];
    const target = getStack(state, toRow, toCol);
    const top = target.length ? target[target.length - 1] : null;
    if (top && top.side === moving.side) return false;
    if (top && target.filter(piece => piece.side === moving.side).length >= 3) return false;
    const option = getMovementTargets(state, fromRow, fromCol).find(p => p.row === toRow && p.col === toCol);
    if (!option) return false;
    if (option.jump) return true;
    const deltaRow = toRow - fromRow;
    const deltaCol = toCol - fromCol;
    const absRow = Math.abs(deltaRow), absCol = Math.abs(deltaCol);
    // Check the exact lattice points between source and destination.
    // This correctly handles diagonal, orthogonal and (2,1)-style offsets.
    function gcd(a, b) {
      while (b !== 0) { const t = b; b = a % b; a = t; }
      return a;
    }
    const divisor = gcd(absRow, absCol);
    if (divisor <= 1) return true;
    const stepRow = deltaRow / divisor, stepCol = deltaCol / divisor;
    for (let step = 1; step < divisor; step += 1) {
      if (getStack(state, fromRow + stepRow * step, fromCol + stepCol * step).length) return false;
    }
    return true;
  }
  function movePiece(state, fromRow, fromCol, toRow, toCol) {
    if (!canMoveTo(state, fromRow, fromCol, toRow, toCol)) {
      return { ok: false, reason: "その移動はできません。" };
    }
    const source = state.board[fromRow][fromCol];
    const movingPiece = source.pop();
    const destination = state.board[toRow][toCol];
    const survivors = resolveLandingStack(movingPiece, destination);
    const captured = destination.filter(piece => piece.side !== movingPiece.side);
    state.board[toRow][toCol] = survivors.concat(movingPiece);
    state.history.push({ type: "move", from:{row:fromRow,col:fromCol}, to:{row:toRow,col:toCol}, piece:movingPiece, captured });
    state.moveNumber += 1;
    state.turn = state.turn === "先手" ? "後手" : "先手";
    return { ok: true, piece: movingPiece, captured };
  }
  function generateLegalMoves(state, side) {
    const moves = [];
    for (let row = 0; row < SIZE; row += 1) for (let col = 0; col < SIZE; col += 1) {
      const stack = state.board[row][col];
      if (!stack.length || stack[stack.length - 1].side !== side) continue;
      for (const target of getMovementTargets(state, row, col)) {
        if (canMoveTo(state, row, col, target.row, target.col)) moves.push({ from:{row,col}, to:{row:target.row,col:target.col}, piece:stack[stack.length-1] });
      }
    }
    return moves;
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
    isInside, getStack, getTopPiece, isMovablePiece, canPlacePiece, placePiece, resolveLandingStack,
    MOVE_RULES, getMovementTargets, canMoveTo, movePiece, generateLegalMoves
  });
})();