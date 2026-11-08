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
    // 初期配置は先手が下3段、後手が上3段のみ。
    if (piece.side === "先手" && row < 6) return false;
    if (piece.side === "後手" && row > 2) return false;
    const stack = state.board[row][col];
    // 初期配置でも最大3段。帥の上、および敵駒の上には置けない。
    if (stack.length >= 3) return false;
    if (stack.length) {
      const top = stack[stack.length - 1];
      if (top.name === "帥" || top.side !== piece.side) return false;
    }
    return true;
  }
  function placePiece(state, row, col, side, pieceId) {
    if (!isInside(row, col) || state.phase !== "setup") return { ok: false, reason: "配置できる局面ではありません。" };
    if (state.setupDone && state.setupDone["先手"]) {
      if (side !== "後手" || state.setupDone["後手"]) return { ok: false, reason: "初期配置は終了しています。" };
    } else if (side !== state.setupTurn) return { ok: false, reason: "現在は" + state.setupTurn + "の配置番です。" };
    const hand = state.hands[side];
    if (!hand) return { ok: false, reason: "陣営が不正です。" };
    const index = hand.findIndex(piece => piece.id === String(pieceId));
    if (index < 0) return { ok: false, reason: "その駒は持ち駒にありません。" };
    const piece = hand[index];
    const hasPlacedAnyPiece = state.history.some(entry => entry.type === "place" && entry.side === side);
    if (!hasPlacedAnyPiece && piece.name !== "帥") return { ok: false, reason: "配置フェーズでは、最初に帥を配置してください。" };
    if (!hasPlacedAnyPiece && piece.name === "帥" && row !== (side === "先手" ? SIZE - 1 : 0))
      return { ok: false, reason: "帥は自陣から見た最前列にのみ配置できます。" };
    if (piece.side === "先手" && row < 6) return { ok: false, reason: "先手は下3段（7〜9段目）にのみ配置できます。" };
    if (piece.side === "後手" && row > 2) return { ok: false, reason: "後手は上3段（1〜3段目）にのみ配置できます。" };
    if (!canPlacePiece(state, row, col, piece)) {
      const stack = state.board[row][col];
      const top = stack.length ? stack[stack.length - 1] : null;
      const reason = stack.length >= 3 ? "3段までしか重ねられません。"
        : top && top.name === "帥" ? "帥の上には配置できません。"
        : top && top.side !== side ? "敵駒の上には配置できません。"
        : piece.name === "帥" && stack.length ? "帥は他の駒があるマスには配置できません。"
        : "このマスには配置できません。";
      return { ok: false, reason };
    }
    hand.splice(index, 1);
    state.board[row][col].push(piece);
    state.history.push({ type: "place", row, col, side, piece, layer: state.board[row][col].length });
    let complete = false;
    if (state.setupFinishPending === side) {
      state.setupFinishPending = null;
      if (side === "先手") {
        state.setupDone["先手"] = true;
        state.setupTurn = "後手";
      } else {
        state.setupDone["後手"] = true;
        state.phase = "move";
        state.turn = "先手";
        complete = true;
      }
    } else if (state.setupDone && state.setupDone["先手"]) {
      state.setupTurn = "後手";
    } else {
      state.setupTurn = side === "先手" ? "後手" : "先手";
    }
    return { ok: true, piece, nextSide: state.setupTurn, complete };
  }
  // 対局中の配置では、敵駒に覆われた味方を最前列の判定から除外する。
  function getFrontmostFriendlyRow(state, side) {
    const rows = [];
    for (let row = 0; row < SIZE; row += 1) for (let col = 0; col < SIZE; col += 1) {
      const stack = state.board[row][col];
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.side === side) rows.push(row);
    }
    if (!rows.length) return null;
    return side === "先手" ? Math.min(...rows) : Math.max(...rows);
  }
  function canDeployPiece(state, row, col, side, piece) {
    if (!isInside(row, col) || !piece || !state.hands[side] || piece.side !== side) return false;
    if (!state.hands[side].some(p => p.id === piece.id)) return false;
    const front = getFrontmostFriendlyRow(state, side);
    // Always keep the full three-rank home deployment zone available,
    // even when the foremost friendly piece has advanced to rank 1 or 2.
    const deploymentBoundary = side === "先手"
      ? Math.min(front === null ? 6 : front, 6)
      : Math.max(front === null ? 2 : front, 2);
    if (side === "先手" ? row < deploymentBoundary : row > deploymentBoundary) return false;
    const stack = state.board[row][col];
    if (stack.length >= 3) return false;
    const top = stack.length ? stack[stack.length - 1] : null;
    if (top && (top.side !== side || top.name === "帥")) return false;
    return true;
  }
  function deployPiece(state, row, col, side, pieceId) {
    if (state.phase === "finished") return { ok: false, reason: "対局は終了しています。" };
    if (side !== state.turn) return { ok: false, reason: "現在の手番では配置できません。" };
    const hand = state.hands[side];
    if (!hand) return { ok: false, reason: "陣営が不正です。" };
    const index = hand.findIndex(piece => piece.id === String(pieceId));
    if (index < 0) return { ok: false, reason: "その駒は持ち駒にありません。" };
    const piece = hand[index];
    if (!canDeployPiece(state, row, col, side, piece)) return { ok: false, reason: "このマスには駒を配置できません。" };
    const positionKey = getPositionKey(state);
    hand.splice(index, 1);
    state.board[row][col].push(piece);
    state.history.push({ type: "deploy", positionKey, row, col, side, piece, layer: state.board[row][col].length });
    state.moveNumber += 1;
    state.turn = state.turn === "先手" ? "後手" : "先手";
    return { ok: true, piece };
  }

  function resolveLandingStack(movingPiece, destinationStack) {
    // Capture is possible only when the topmost piece is an enemy.
    // If a friendly piece is on top, enemy pieces beneath it are covered
    // and must remain in the stack.
    const top = destinationStack.length ? destinationStack[destinationStack.length - 1] : null;
    if (top && top.side === movingPiece.side) return destinationStack.slice();
    return destinationStack.filter(piece => piece.side === movingPiece.side);
  }

  // Movement vectors use (forward, right). Forward is rotated by side.
  // Each entry lists destinations added at that stack level.
  const MOVE_RULES = Object.freeze({
    "帥": {1:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],2:[[2,0],[-2,0],[0,2],[0,-2],[2,2],[2,-2],[-2,2],[-2,-2]],3:[[3,0],[-3,0],[0,3],[0,-3],[3,3],[3,-3],[-3,3],[-3,-3]]},
    "大将": {1:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],2:[[2,2],[2,-2],[-2,2],[-2,-2]],3:[[3,3],[3,-3],[-3,3],[-3,-3]],rays:[[1,0],[-1,0],[0,1],[0,-1]]},
    "中将": {1:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],2:[[2,0],[-2,0],[0,2],[0,-2]],3:[[3,0],[-3,0],[0,3],[0,-3]],rays:[[1,1],[1,-1],[-1,1],[-1,-1]]},
    "少将": {1:[[1,0],[1,1],[1,-1],[0,1],[0,-1],[-1,0]],2:[[2,0],[2,2],[2,-2],[0,2],[0,-2],[-2,0]],3:[[3,0],[3,3],[3,-3],[0,3],[0,-3],[-3,0]]},
    "侍": {1:[[1,0],[1,1],[1,-1],[-1,0]],2:[[2,0],[2,2],[2,-2],[-2,0]],3:[[3,0],[3,3],[3,-3],[-3,0]]},
    "槍": {1:[[1,0],[2,0],[1,1],[1,-1],[-1,0]],2:[[1,0],[2,0],[3,0],[2,2],[2,-2],[-2,0]],3:[[1,0],[3,0],[4,0],[3,3],[3,-3],[-3,0]]},
    "騎": {1:[[1,0],[-1,0],[2,0],[-2,0],[0,1],[0,-1]],2:[[2,0],[-2,0],[3,0],[-3,0],[0,2],[0,-2]],3:[[3,0],[-3,0],[4,0],[-4,0],[0,3],[0,-3]]},
    "忍": {1:[[1,1],[1,-1],[-1,1],[-1,-1],[2,2],[2,-2],[-2,2],[-2,-2]],2:[[3,3],[3,-3],[-3,3],[-3,-3]],3:[[4,4],[4,-4],[-4,4],[-4,-4]]},
    "砦": {1:[[1,0],[0,1],[0,-1],[-1,1],[-1,-1]],2:[[2,0],[0,2],[0,-2],[-2,2],[-2,-2]],3:[[3,0],[0,3],[0,-3],[-3,3],[-3,-3]]},
    "兵": {1:[[1,0],[-1,0]],2:[[2,0],[-2,0]],3:[[3,0],[-3,0]]},
    "砲": {1:[[3,0],[0,1],[0,-1],[-1,0]],2:[[4,0],[0,2],[0,-2],[-2,0]],3:[[5,0],[0,3],[0,-3],[-3,0]],jumps:[[3,0],[4,0],[5,0]]},
    "弓": {1:[[2,0],[2,1],[2,-1],[-1,0]],2:[[3,0],[3,2],[3,-2],[-2,0]],3:[[4,0],[4,3],[4,-3],[-3,0]],jumps:[[2,0],[2,1],[2,-1],[3,0],[3,2],[3,-2],[4,0],[4,3],[4,-3]]},
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
    // A non-Marshal may never land on a stack containing its own Marshal.
    if (moving.name !== "帥" && target.some(piece => piece.side === moving.side && piece.name === "帥")) return false;
    // 味方へのツケは、相手先の段数が移動元の段数以下で、
    // かつ移動先が3段未満の場合のみ可能。
    if (top && target.length > source.length) return false;
    if (top && top.side === moving.side && target.length >= 3) return false;
    const option = getMovementTargets(state, fromRow, fromCol).find(p => p.row === toRow && p.col === toCol);
    if (!option) return false;
    if (option.jump) {
      // 筒・砲の前方射程では、自分より高い段数の駒が途中にあると
      // その地点より先へは飛び越えられない。同段以下は飛び越え可能。
      if ((moving.name === "筒" || moving.name === "砲") && toCol === fromCol) {
        const forward = moving.side === "先手" ? -1 : 1;
        const delta = toRow - fromRow;
        if (Math.sign(delta) === forward) {
          const distance = Math.abs(delta);
          for (let step = 1; step < distance; step += 1) {
            const obstacle = getStack(state, fromRow + forward * step, fromCol);
            if (obstacle.length > source.length) return false;
          }
        }
      }
      if (moving.name === "弓") {
        const forward = moving.side === "先手" ? -1 : 1;
        const df = (toRow - fromRow) * forward;
        const dr = toCol - fromCol;
        if (df > 0 && Math.abs(dr) <= df) {
          const higher = (f, r) => {
            const stack = getStack(state, fromRow + forward * f, fromCol + r);
            return stack && stack.length > source.length;
          };
          if (higher(1, 0)) return false;
          if (dr > 0 && higher(1, 1)) return false;
          if (dr < 0 && higher(1, -1)) return false;
          const diagonal = Math.sign(dr);
          if (diagonal !== 0) {
            for (let f = 2; f < df; f += 1) {
              if (higher(f, diagonal * (f - 1))) return false;
            }
          } else {
            for (let f = 2; f < df; f += 1) {
              if (higher(f, 0)) return false;
            }
          }
        }
      }
      return true;
    }
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
  // 同一局面から同一手を3回指すことを禁止するための局面識別子。
  // 駒IDではなく種類・陣営・段構成と持ち駒数で判定し、同種駒の入れ替わりに左右されない。
  function getPositionKey(state) {
    const board = state.board.map(row => row.map(stack => stack.map(piece => piece.side + ":" + piece.name)));
    const hands = {};
    for (const side of ["先手", "後手"]) {
      hands[side] = {};
      for (const piece of state.hands[side] || []) hands[side][piece.name] = (hands[side][piece.name] || 0) + 1;
    }
    return JSON.stringify({ board, hands, turn: state.turn });
  }
  function sameMoveAtPosition(entry, positionKey, fromRow, fromCol, toRow, toCol, landingMode) {
    // 捕獲とツケは別の手として数える。
    return entry.type === "move" && entry.positionKey === positionKey &&
      entry.from && entry.to && entry.from.row === fromRow && entry.from.col === fromCol &&
      entry.to.row === toRow && entry.to.col === toCol && (entry.landingMode || "capture") === landingMode;
  }
  function movePiece(state, fromRow, fromCol, toRow, toCol, landingMode = "capture") {
    const sourceStack = getStack(state, fromRow, fromCol);
    const sourceTop = sourceStack && sourceStack.length ? sourceStack[sourceStack.length - 1] : null;
    if (state.phase === "finished") return { ok: false, reason: "対局は終了しています。" };
    if (!sourceTop || sourceTop.side !== state.turn) {
      return { ok: false, reason: "現在の手番ではないため、その駒は動かせません。" };
    }
    if (!canMoveTo(state, fromRow, fromCol, toRow, toCol)) {
      return { ok: false, reason: "その移動はできません。" };
    }
    const positionKey = getPositionKey(state);
    const repeatedCount = state.history.reduce((count, entry) => count + (sameMoveAtPosition(entry, positionKey, fromRow, fromCol, toRow, toCol, landingMode) ? 1 : 0), 0);
    if (repeatedCount >= 2) return { ok: false, reason: "同じ局面から同じ手を3回以上指すことはできません。" };
    const destinationBefore = state.board[toRow][toCol];
    const destinationTop = destinationBefore.length ? destinationBefore[destinationBefore.length - 1] : null;
    // Occupied squares require an explicit landing choice.
    if (destinationTop) {
      if (landingMode !== "capture" && landingMode !== "tsuke") return { ok: false, reason: "移動方法を選択してください。" };
      if (landingMode === "capture" && destinationTop.side === sourceTop.side) return { ok: false, reason: "味方の駒は取れません。ツケを選択してください。" };
      if (landingMode === "tsuke" && destinationBefore.length >= 3) return { ok: false, reason: "4段目になるため、ツケることはできません。" };
    } else if (landingMode !== "capture") {
      return { ok: false, reason: "この移動方法は選択できません。" };
    }
    const source = state.board[fromRow][fromCol];
    const fromLayer = source.length;
    const movingPiece = source.pop();
    const destination = state.board[toRow][toCol];
    const hasFriendlyOnDestination = destination.some(piece => piece.side === movingPiece.side);
    const captured = landingMode === "capture" && destinationTop && destinationTop.side !== movingPiece.side
      ? (hasFriendlyOnDestination
          ? [destinationTop]
          : destination.filter(piece => piece.side !== movingPiece.side))
      : [];
    const survivors = landingMode === "tsuke"
      ? destination.slice()
      : destination.filter(piece => !captured.includes(piece));
    state.board[toRow][toCol] = survivors.concat(movingPiece);
    const toLayer = state.board[toRow][toCol].length;
    state.history.push({ type: "move", positionKey, from:{row:fromRow,col:fromCol,layer:fromLayer}, to:{row:toRow,col:toCol,layer:toLayer}, fromLayer, toLayer, piece:movingPiece, captured, landingMode });
    state.moveNumber += 1;
    const capturedMarshal = captured.some(piece => piece.name === "帥");
    if (capturedMarshal) {
      state.phase = "finished";
      state.winner = movingPiece.side;
    } else {
      state.turn = state.turn === "先手" ? "後手" : "先手";
    }
    return { ok: true, piece: movingPiece, captured, gameOver: capturedMarshal, winner: capturedMarshal ? movingPiece.side : null };
  }
  // 帥の位置を取得する。盤上に存在しない場合は null。
  function getMarshalPosition(state, side) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const stack = state.board[row][col];
        const marshal = stack.find(piece => piece.side === side && piece.name === "帥");
        if (marshal) return { row, col, piece: marshal, stack };
      }
    }
    return null;
  }

  // 相手の駒が通常の移動・捕獲規則で帥を実際に取れるかを判定する。
  function isInCheck(state, side) {
    const marshalPosition = getMarshalPosition(state, side);
    if (!marshalPosition) return false;
    const attacker = side === "先手" ? "後手" : "先手";
    const targetStack = marshalPosition.stack;
    const targetTop = targetStack[targetStack.length - 1];
    if (!targetTop || targetTop.side === attacker) return false;

    // 通常の捕獲処理で帥が捕獲対象になる場合だけ王手とする。
    const attackersAlreadyOnTarget = targetStack.some(piece => piece.side === attacker);
    const captured = attackersAlreadyOnTarget
      ? [targetTop]
      : targetStack.filter(piece => piece.side !== attacker);
    if (!captured.some(piece => piece.name === "帥" && piece.side === side)) return false;

    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const stack = state.board[row][col];
        if (!stack.length || stack[stack.length - 1].side !== attacker) continue;
        if (canMoveTo(state, row, col, marshalPosition.row, marshalPosition.col)) return true;
      }
    }
    return false;
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

  function finishSetup(state, side) {
    if (state.phase !== "setup") return { ok: false, reason: "初期配置はすでに終了しています。" };
    if (side !== state.setupTurn) return { ok: false, reason: "現在は" + state.setupTurn + "の配置番です。" };
    if (state.setupFinishPending) return { ok: false, reason: "「済」は押されています。駒を1つ配置してください。" };
    const hasPlacedMarshal = state.history.some(entry => entry.type === "place" && entry.side === side && entry.piece.name === "帥");
    if (!hasPlacedMarshal) return { ok: false, reason: side + "は先に帥を配置してください。" };
    state.setupFinishPending = side;
    return { ok: true, complete: false, pendingPlacement: true, nextSide: side };
  }

  function createGameState() {
    return {
      board: createEmptyBoard(),
      hands: { "先手": createInventory("先手"), "後手": createInventory("後手") },
      turn: "先手", setupTurn: "先手", setupDone: { "先手": false, "後手": false }, setupFinishPending: null, phase: "setup", winner: null, moveNumber: 1, history: []
    };
  }
  window.GungiEngine = Object.freeze({
    SIZE, PIECE_COUNTS, createEmptyBoard, createPiece, createInventory, createGameState,
    isInside, getStack, getTopPiece, isMovablePiece, canPlacePiece, placePiece, finishSetup, getFrontmostFriendlyRow, canDeployPiece, deployPiece, resolveLandingStack,
    MOVE_RULES, getMovementTargets, canMoveTo, movePiece, getMarshalPosition, isInCheck, generateLegalMoves
  });
})();