/* Gungi AI — position evaluation.
 * Scores are centipawn-like units from the requested side's view.
 * The evaluator is read-only; all tactical legality comes from the rules engine.
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
  const WEIGHT_KEYS = ["material", "hand", "position", "activity", "mobility", "threats", "exposure", "kingSafety"];
  const weights = Object.fromEntries(WEIGHT_KEYS.map(key => [key, 1]));

  function setWeights(next) {
    for (const key of WEIGHT_KEYS) {
      const value = Number(next && next[key]);
      if (Number.isFinite(value)) weights[key] = Math.max(0.25, Math.min(2.5, value));
    }
    return getWeights();
  }
  function getWeights() { return Object.freeze({ ...weights }); }
  function weightedTotal(parts) {
    return Math.round(WEIGHT_KEYS.reduce((sum, key) => sum + (parts[key] || 0) * weights[key], 0));
  }
  function opponent(side) { return side === "先手" ? "後手" : "先手"; }
  function advancement(row, side) { return side === "先手" ? 8 - row : row; }

  function positionalBonus(row, col, side, pieceName) {
    const centerDistance = Math.abs(row - CENTER) + Math.abs(col - CENTER);
    const centrality = Math.max(0, 8 - centerDistance) * 2;
    const advance = advancement(row, side);
    const advanceWeight = pieceName === "帥" ? 0.35 : 1.25;
    return centrality + advance * advanceWeight;
  }

  function capturablePieces(targetStack, attackingSide) {
    if (!targetStack.length || targetStack[targetStack.length - 1].side === attackingSide) return [];
    const hasFriendlyUnderneath = targetStack.some(piece => piece.side === attackingSide);
    return hasFriendlyUnderneath
      ? [targetStack[targetStack.length - 1]]
      : targetStack.filter(piece => piece.side !== attackingSide);
  }

  function sideBreakdown(state, side) {
    let material = 0, hand = 0, position = 0, activity = 0;
    let threats = 0, exposure = 0, kingSafety = 0;
    let boardPieces = 0, handPieces = 0;

    const enemy = opponent(side);
    const moveList = E.generateLegalMoves(state, side);
    const enemyMoves = E.generateLegalMoves(state, enemy);
    const moveCountByPiece = new Map();
    const controlledSquares = new Map();

    for (const move of moveList) {
      const id = move.piece.id;
      moveCountByPiece.set(id, (moveCountByPiece.get(id) || 0) + 1);
      const key = move.to.row + "," + move.to.col;
      if (!controlledSquares.has(key)) controlledSquares.set(key, move.to);
    }

    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const stack = state.board[row][col];
        if (!stack.length) continue;
        for (let layer = 0; layer < stack.length; layer += 1) {
          const piece = stack[layer];
          if (piece.side !== side) continue;
          const value = PIECE_VALUES[piece.name] || 0;
          const isTop = layer === stack.length - 1;
          material += value * (isTop ? 1 : 0.88);
          boardPieces += 1;
          if (isTop) {
            position += positionalBonus(row, col, side, piece.name);
            // Stacked pieces are protected, but remain less useful while buried.
            activity += Math.max(0, stack.length - 1) * 7;
            const legalCount = moveCountByPiece.get(piece.id) || 0;
            activity += Math.min(8, legalCount) * 1.8;
          }
        }
      }
    }

    // Reserve pieces retain strategic flexibility, but are discounted until deployed.
    const reserve = state.hands && state.hands[side] ? state.hands[side] : [];
    for (const piece of reserve) {
      hand += (PIECE_VALUES[piece.name] || 0) * 0.76;
      handPieces += 1;
    }

    // Reward useful influence over central and advanced squares, counting each
    // destination once so pieces do not inflate the score by duplicating a ray.
    let controlScore = 0;
    for (const square of controlledSquares.values()) {
      const distance = Math.abs(square.row - CENTER) + Math.abs(square.col - CENTER);
      const centralValue = Math.max(0, 7 - distance) * 0.55;
      const advanceValue = advancement(square.row, side) * 0.22;
      controlScore += centralValue + advanceValue;
    }
    position += Math.min(65, controlScore);

    // Reward adjacent friendly top pieces as a modest coordination bonus.
    let friendlyPairs = 0;
    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const stack = state.board[row][col];
        if (!stack.length || stack[stack.length - 1].side !== side) continue;
        for (const [dr, dc] of [[1,0],[0,1],[1,1],[1,-1]]) {
          const r = row + dr, c = col + dc;
          if (r < 0 || r >= E.SIZE || c < 0 || c >= E.SIZE) continue;
          const adjacent = state.board[r][c];
          if (adjacent.length && adjacent[adjacent.length - 1].side === side) friendlyPairs += 1;
        }
      }
    }
    position += Math.min(36, friendlyPairs * 3);

    // Deduplicate threats by target square. Multiple attackers improve pressure,
    // but must not count the same capturable stack as several separate prizes.
    const enemyTargets = new Map();
    for (const move of enemyMoves) {
      const key = move.to.row + "," + move.to.col;
      const targetStack = state.board[move.to.row][move.to.col];
      const capturable = capturablePieces(targetStack, enemy);
      if (!capturable.length) continue;
      const value = capturable.reduce((sum, piece) => sum + (PIECE_VALUES[piece.name] || 0), 0);
      const item = enemyTargets.get(key) || { value, attackers: 0 };
      item.value = Math.max(item.value, value);
      item.attackers += 1;
      enemyTargets.set(key, item);
    }
    for (const item of enemyTargets.values()) {
      exposure -= Math.min(360, item.value * 0.18 *
        (1 + Math.min(2, item.attackers - 1) * 0.3));
    }

    const ownTargets = new Map();
    for (const move of moveList) {
      const key = move.to.row + "," + move.to.col;
      const targetStack = state.board[move.to.row][move.to.col];
      const capturable = capturablePieces(targetStack, side);
      if (!capturable.length) continue;
      const value = capturable.reduce((sum, piece) => sum + (PIECE_VALUES[piece.name] || 0), 0);
      const item = ownTargets.get(key) || { value, attackers: 0 };
      item.value = Math.max(item.value, value);
      item.attackers += 1;
      ownTargets.set(key, item);
    }
    for (const item of ownTargets.values()) {
      threats += Math.min(180, item.value * 0.16 *
        (1 + Math.min(2, item.attackers - 1) * 0.3));
    }

    const marshal = E.getMarshalPosition(state, side);
    if (E.isInCheck(state, side)) kingSafety -= 5200;
    if (marshal) {
      let nearbyFriends = 0;
      const adjacentSquares = new Set();
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const r = marshal.row + dr, c = marshal.col + dc;
          if (r < 0 || r >= E.SIZE || c < 0 || c >= E.SIZE) continue;
          const stack = state.board[r][c];
          if (stack.length && stack[stack.length - 1].side === side) nearbyFriends += 1;
          adjacentSquares.add(r + "," + c);
        }
      }
      kingSafety += nearbyFriends * 9;

      // Nearby enemy control is a warning signal even before it becomes check.
      let threatenedAdjacent = 0;
      for (const move of enemyMoves) {
        const key = move.to.row + "," + move.to.col;
        if (adjacentSquares.has(key)) threatenedAdjacent += 1;
      }
      kingSafety -= Math.min(126, threatenedAdjacent * 18);

      // A Marshal with legal escape squares is less vulnerable to a forced net.
      const marshalEscapes = moveList.filter(move => move.piece.id === marshal.piece.id).length;
      kingSafety += Math.min(4, marshalEscapes) * 7;
    }

    const mobility = moveList.length;
    const parts = {
      material: Math.round(material),
      hand: Math.round(hand),
      position: Math.round(position),
      activity: Math.round(activity),
      mobility: Math.round(mobility * 2.2),
      threats: Math.round(threats),
      exposure: Math.round(exposure),
      kingSafety: Math.round(kingSafety)
    };
    return {
      ...parts,
      boardPieces,
      handPieces,
      total: weightedTotal(parts)
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
      weights: getWeights(),
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
    setWeights,
    getWeights,
    evaluate,
    evaluateBreakdown
  });
})();
