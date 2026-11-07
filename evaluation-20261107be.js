/* Gungi AI — position evaluation.
 * Scores are expressed in centipawn-like units from the requested side's view.
 * This module is deliberately separate from the rules engine and does not mutate game state.
 */
(() => {
  "use strict";
  const E = window.GungiEngine;
  if (!E) throw new Error("GungiEngine must be loaded before the evaluator.");

  const PIECE_VALUES = Object.freeze({
    "兵": 100, "侍": 230, "砦": 250, "槍": 275, "騎": 300,
    "忍": 260, "弓": 290, "謀": 245, "筒": 305, "砲": 335,
    "少将": 440, "中将": 500, "大将": 590, "帥": 20000
  });
  const SIDES = Object.freeze(["先手", "後手"]);
  const CENTER = 4;

  function opponent(side) {
    return side === "先手" ? "後手" : "先手";
  }

  function advancement(row, side) {
    return side === "先手" ? 8 - row : row;
  }

  function positionalBonus(row, col, side, pieceName) {
    const centerDistance = Math.abs(row - CENTER) + Math.abs(col - CENTER);
    const centrality = Math.max(0, 8 - centerDistance) * 2;
    const advance = advancement(row, side);
    const advanceWeight = pieceName === "帥" ? 0.35 : 1.25;
    return centrality + advance * advanceWeight;
  }

  function sideBreakdown(state, side) {
    let material = 0;
    let hand = 0;
    let position = 0;
    let activity = 0;
    let threats = 0;
    let exposure = 0;
    let kingSafety = 0;
    let boardPieces = 0;
    let handPieces = 0;
    let mobility = 0;

    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const stack = state.board[row][col];
        if (!stack.length) continue;
        for (let layer = 0; layer < stack.length; layer += 1) {
          const piece = stack[layer];
          if (piece.side !== side) continue;
          const value = PIECE_VALUES[piece.name] || 0;
          const isTop = layer === stack.length - 1;
          // Buried pieces retain most of their material value, but cannot move.
          material += value * (isTop ? 1 : 0.88);
          boardPieces += 1;
          if (isTop) {
            position += positionalBonus(row, col, side, piece.name);
            activity += Math.max(0, stack.length - 1) * 7;
          }
        }
      }
    }

    const reserve = state.hands && state.hands[side] ? state.hands[side] : [];
    for (const piece of reserve) {
      hand += (PIECE_VALUES[piece.name] || 0) * 0.76;
      handPieces += 1;
    }

    try {
      mobility = E.generateLegalMoves(state, side).length;
    } catch (_) {
      mobility = 0;
    }

    // Legal capture pressure. Use the engine's complete move legality,
    // including stack-height and piece-specific jump restrictions.
    const enemy = opponent(side);
    const ownMoves = E.generateLegalMoves(state, side);
    const enemyMoves = E.generateLegalMoves(state, enemy);
    const attacksBySquare = new Map();
    for (const move of enemyMoves) {
      const key = move.to.row + "," + move.to.col;
      const list = attacksBySquare.get(key) || [];
      list.push(move.piece);
      attacksBySquare.set(key, list);
    }

    // Mirror the engine's capture rule when estimating the material at risk.
    for (const [key, attackers] of attacksBySquare) {
      const [row, col] = key.split(",").map(Number);
      const targetStack = state.board[row][col];
      if (!targetStack.length || targetStack[targetStack.length - 1].side === enemy) continue;
      const attackerHasSupport = targetStack.some(piece => piece.side === enemy);
      const capturable = attackerHasSupport
        ? [targetStack[targetStack.length - 1]]
        : targetStack.filter(piece => piece.side === side);
      const loss = capturable.reduce((sum, piece) => sum + (PIECE_VALUES[piece.name] || 0), 0);
      if (!loss) continue;
      const pressure = Math.min(360, loss * 0.18 * (1 + Math.min(2, attackers.length - 1) * 0.3));
      exposure -= pressure;
    }

    // Score this side's own legal capture opportunities separately.
    for (const move of ownMoves) {
      const targetStack = state.board[move.to.row][move.to.col];
      if (!targetStack.length || targetStack[targetStack.length - 1].side === side) continue;
      const hasFriendlyUnderneath = targetStack.some(piece => piece.side === side);
      const capturable = hasFriendlyUnderneath
        ? [targetStack[targetStack.length - 1]]
        : targetStack.filter(piece => piece.side === enemy);
      const value = capturable.reduce((sum, piece) => sum + (PIECE_VALUES[piece.name] || 0), 0);
      threats += Math.min(180, value * 0.16);
    }

    if (E.isInCheck(state, side)) kingSafety -= 5200;

    const marshal = E.getMarshalPosition(state, side);
    if (marshal) {
      let nearbyFriends = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const r = marshal.row + dr, c = marshal.col + dc;
          if (r < 0 || r >= E.SIZE || c < 0 || c >= E.SIZE) continue;
          const stack = state.board[r][c];
          if (stack.length && stack[stack.length - 1].side === side) nearbyFriends += 1;
        }
      }
      kingSafety += nearbyFriends * 9;
    }

    return {
      material: Math.round(material),
      hand: Math.round(hand),
      position: Math.round(position),
      activity: Math.round(activity),
      mobility: Math.round(mobility * 2.2),
      threats: Math.round(threats),
      exposure: Math.round(exposure),
      kingSafety: Math.round(kingSafety),
      boardPieces,
      handPieces,
      total: Math.round(material + hand + position + activity + mobility * 2.2 + threats + exposure + kingSafety)
    };
  }

  function evaluateBreakdown(state) {
    if (!state || !Array.isArray(state.board) || !state.hands) {
      throw new TypeError("有効な軍儀の局面を指定してください。");
    }
    const first = sideBreakdown(state, "先手");
    const second = sideBreakdown(state, "後手");
    let terminal = null;
    if (state.phase === "finished" && state.winner) {
      terminal = state.winner === "先手" ? 100000000 : -100000000;
    }
    return {
      "先手": first,
      "後手": second,
      score: terminal === null ? first.total - second.total : terminal,
      terminal
    };
  }

  function evaluate(state, perspective = "先手") {
    if (perspective !== "先手" && perspective !== "後手") {
      throw new TypeError("評価する陣営は「先手」または「後手」です。");
    }
    const result = evaluateBreakdown(state);
    return perspective === "先手" ? result.score : -result.score;
  }

  window.GungiAI = Object.freeze({
    PIECE_VALUES,
    evaluate,
    evaluateBreakdown
  });
})();
