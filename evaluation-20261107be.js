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
  const WEIGHT_KEYS = ["material", "hand", "position", "activity", "mobility", "threats", "exposure", "kingSafety", "mateNet"];
  const weights = Object.fromEntries(WEIGHT_KEYS.map(key => [key, 1]));

  function setWeights(next) {
    for (const key of WEIGHT_KEYS) {
      const value = Number(next && next[key]);
      if (Number.isFinite(value)) weights[key] = Math.max(0.25, Math.min(2.5, value));
    }
    return getWeights();
  }
  function getWeights() { return Object.freeze({ ...weights }); }
  // NNUE型の軽量評価ヘッド。
  // 9種類の局面特徴を正負18チャネルに分けたReLU特徴変換へ通し、
  // 出力層で従来の評価重みを合成する。初期状態では旧評価値と完全一致し、
  // 既存の学習重み・引き継ぎデータとの互換性を保つ。
  const NNUE_CHANNELS = WEIGHT_KEYS.flatMap(key => [
    { key, sign: 1 }, { key, sign: -1 }
  ]);
  function nnueForward(parts) {
    let output = 0;
    for (const channel of NNUE_CHANNELS) {
      const activation = Math.max(0, (Number(parts[channel.key]) || 0) * channel.sign);
      output += activation * weights[channel.key] * channel.sign;
    }
    return Math.round(output);
  }
  const breakdownCache = new WeakMap();
  function weightsSignature() {
    return WEIGHT_KEYS.map(key => weights[key]).join(",");
  }
  function weightedTotal(parts) {
    return nnueForward(parts);
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

  function countSafeMarshalEscapes(state, side, moves, marshal) {
    if (!marshal) return 0;
    let safe = 0;
    for (const move of moves) {
      if (move.piece.id !== marshal.piece.id) continue;
      const nextState = {
        ...state,
        turn: side,
        board: state.board.map(line => line.map(stack => stack.slice())),
        hands: state.hands,
        history: Array.isArray(state.history) ? state.history.slice() : []
      };
      const destination = nextState.board[move.to.row][move.to.col];
      const landingMode = destination.length && destination[destination.length - 1].side === side
        ? "tsuke" : "capture";
      const result = E.movePiece(nextState, move.from.row, move.from.col,
        move.to.row, move.to.col, landingMode);
      if (result.ok && !result.gameOver && !E.isInCheck(nextState, side)) safe += 1;
    }
    return safe;
  }

  function countSafeCheckResponses(state, side, moves) {
    let safe = 0;
    for (const move of moves) {
      const nextState = {
        ...state, turn: side,
        board: state.board.map(line => line.map(stack => stack.slice())),
        hands: state.hands,
        history: Array.isArray(state.history) ? state.history.slice() : []
      };
      const destination = nextState.board[move.to.row][move.to.col];
      const landingMode = destination.length && destination[destination.length - 1].side === side ? "tsuke" : "capture";
      const result = E.movePiece(nextState, move.from.row, move.from.col, move.to.row, move.to.col, landingMode);
      if (result.ok && ((result.gameOver && result.winner === side) || !E.isInCheck(nextState, side))) safe += 1;
    }
    return safe;
  }

  function sideBreakdown(state, side) {
    let material = 0, hand = 0, position = 0, activity = 0;
    let threats = 0, exposure = 0, kingSafety = 0, mateNet = 0;
    let boardPieces = 0, handPieces = 0;

    const enemy = opponent(side);
    const moveList = E.generateLegalMoves(state, side);
    const enemyMoves = E.generateLegalMoves(state, enemy);
    const enemyMarshalForStack = E.getMarshalPosition(state, enemy);
    const moveCountByPiece = new Map();
    const movesByPiece = new Map();
    const controlledSquares = new Map();
    const controllersBySquare = new Map();

    for (const move of moveList) {
      const id = move.piece.id;
      moveCountByPiece.set(id, (moveCountByPiece.get(id) || 0) + 1);
      if (!movesByPiece.has(id)) movesByPiece.set(id, []);
      movesByPiece.get(id).push(move);
      const key = move.to.row + "," + move.to.col;
      if (!controlledSquares.has(key)) controlledSquares.set(key, move.to);
      if (!controllersBySquare.has(key)) controllersBySquare.set(key, new Set());
      controllersBySquare.get(key).add(id);
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
            // A stack gains tactical reach from its height, but buried pieces
            // are not treated as independently active. Reward height more when
            // the exposed top piece actually has useful legal mobility.
            const depth = Math.max(0, stack.length - 1);
            const legalCount = moveCountByPiece.get(piece.id) || 0;
            // 高さそのものには加点せず、ツケた結果として得た移動能力だけを評価する。
            activity += depth * Math.min(6, legalCount) * 0.65;
            activity += Math.min(8, legalCount) * 1.4;
          }
        }
      }
    }

    // ツケによって最上段の駒が得た攻撃的な移動先の質を評価する。
    // 駒の保護や段数そのものには加点せず、敵帥への接近・包囲に役立つ移動だけを見る。
    if (enemyMarshalForStack) {
      let stackedTacticalActivity = 0;
      for (let row = 0; row < E.SIZE; row += 1) {
        for (let col = 0; col < E.SIZE; col += 1) {
          const stack = state.board[row][col];
          if (stack.length < 2 || stack[stack.length - 1].side !== side) continue;
          const top = stack[stack.length - 1];
          const currentDistance = Math.abs(row - enemyMarshalForStack.row) + Math.abs(col - enemyMarshalForStack.col);
          const qualities = [];
          for (const move of (movesByPiece.get(top.id) || [])) {
            const target = state.board[move.to.row][move.to.col];
            const targetTop = target.length ? target[target.length - 1] : null;
            // 捕獲の価値は既存の threats で評価するため、ここでは重複させない。
            if (targetTop && targetTop.side !== side) continue;
            const nextDistance = Math.abs(move.to.row - enemyMarshalForStack.row) +
              Math.abs(move.to.col - enemyMarshalForStack.col);
            const distanceGain = Math.max(0, currentDistance - nextDistance);
            const advanceGain = Math.max(0, advancement(move.to.row, side) - advancement(row, side));
            const marshalZone = nextDistance <= 1 ? 18 : nextDistance <= 2 ? 10 : nextDistance <= 4 ? 4 : 0;
            const quality = distanceGain * 4 + advanceGain * 2 + marshalZone;
            if (quality > 0) qualities.push(quality);
          }
          qualities.sort((a, b) => b - a);
          const bestThree = qualities.slice(0, 3).reduce((sum, value) => sum + value, 0);
          const depthFactor = 1 + Math.max(0, stack.length - 2) * 0.25;
          stackedTacticalActivity += Math.min(48, bestThree) * depthFactor;
        }
      }
      activity += Math.min(150, stackedTacticalActivity);
    }

    // 全ての最上段駒について、敵帥へ近づき、かつ前進する合法手を評価する。
    // 捕獲先は既存の threats と重複するため除外し、各駒の上位2手だけを加点する。
    if (enemyMarshalForStack) {
      let purposefulAdvance = 0;
      const seenTopPieces = new Set();
      for (let row = 0; row < E.SIZE; row += 1) {
        for (let col = 0; col < E.SIZE; col += 1) {
          const stack = state.board[row][col];
          if (!stack.length || stack[stack.length - 1].side !== side) continue;
          const top = stack[stack.length - 1];
          if (seenTopPieces.has(top.id)) continue;
          seenTopPieces.add(top.id);
          const currentDistance = Math.abs(row - enemyMarshalForStack.row) + Math.abs(col - enemyMarshalForStack.col);
          const gains = [];
          for (const move of (movesByPiece.get(top.id) || [])) {
            const target = state.board[move.to.row][move.to.col];
            if (target.length && target[target.length - 1].side !== side) continue;
            const nextDistance = Math.abs(move.to.row - enemyMarshalForStack.row) +
              Math.abs(move.to.col - enemyMarshalForStack.col);
            const distanceGain = Math.max(0, currentDistance - nextDistance);
            const advanceGain = Math.max(0, advancement(move.to.row, side) - advancement(row, side));
            if (distanceGain || advanceGain) gains.push(distanceGain * 3 + advanceGain * 2);
          }
          gains.sort((a, b) => b - a);
          purposefulAdvance += Math.min(22, (gains[0] || 0) + (gains[1] || 0) * 0.35);
        }
      }
      activity += Math.min(110, purposefulAdvance);
    }

    // 敵帥を次の一手で実際に捕獲できる合法手がある場合は、非常に大きく評価する。
    // 単なる射程・隣接ではなく、軍儀エンジンの捕獲対象判定に帥が含まれるかで確認する。
    if (enemyMarshalForStack) {
      const marshalStack = state.board[enemyMarshalForStack.row][enemyMarshalForStack.col];
      const marshalCapturable = capturablePieces(marshalStack, side)
        .some(piece => piece.name === "帥" && piece.side === enemy);
      if (marshalCapturable && moveList.some(move =>
        move.to.row === enemyMarshalForStack.row && move.to.col === enemyMarshalForStack.col
      )) mateNet += 25000;
      // 敵帥の周囲8マスを複数の駒で制圧するほど、逃げ道を狭める攻めとして評価する。
      const ring = new Set();
      for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        const r = enemyMarshalForStack.row + dr, c = enemyMarshalForStack.col + dc;
        if (r < 0 || r >= E.SIZE || c < 0 || c >= E.SIZE) continue;
        if (controlledSquares.has(r + "," + c)) ring.add(r + "," + c);
      }
      threats += Math.min(96, ring.size * 12);
    }

    // Reserve pieces retain strategic flexibility. Slightly increase their value
    // so the evaluator does not rush to deploy every useful piece.
    const reserve = state.hands && state.hands[side] ? state.hands[side] : [];
    for (const piece of reserve) {
      hand += (PIECE_VALUES[piece.name] || 0) * 0.82;
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

    // Redundant control is useful: two different pieces contesting the same
    // square make a plan less fragile than a single-piece threat. Give extra
    // value to coordinated control close to the opposing Marshal.
    const enemyMarshal = enemyMarshalForStack;
    let coordinatedControl = 0;
    for (const [key, controllers] of controllersBySquare) {
      if (controllers.size < 2) continue;
      const [row, col] = key.split(",").map(Number);
      const distanceToEnemyMarshal = enemyMarshal
        ? Math.abs(row - enemyMarshal.row) + Math.abs(col - enemyMarshal.col)
        : 8;
      const strategicFactor = distanceToEnemyMarshal <= 2 ? 1.8
        : distanceToEnemyMarshal <= 4 ? 1.25 : 1;
      coordinatedControl += Math.min(2, controllers.size - 1) * strategicFactor;
    }
    position += Math.min(24, coordinatedControl * 1.6);

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
    position += Math.min(30, friendlyPairs * 2.5);

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

    // 敵帥の近くにいる攻撃駒を評価する。敵の次の手で捕獲される駒は
    // 攻めの拠点として信頼しにくいため、圧力への寄与を大きく割り引く。
    if (enemyMarshalForStack) {
      let safeApproachPressure = 0;
      let safeApproachAttackers = 0;
      for (let row = 0; row < E.SIZE; row += 1) {
        for (let col = 0; col < E.SIZE; col += 1) {
          const stack = state.board[row][col];
          if (!stack.length || stack[stack.length - 1].side !== side ||
              stack[stack.length - 1].name === "帥") continue;
          const distance = Math.abs(row - enemyMarshalForStack.row) +
            Math.abs(col - enemyMarshalForStack.col);
          if (distance > 3) continue;
          const safe = !enemyTargets.has(row + "," + col);
          const base = distance === 1 ? 42 : distance === 2 ? 26 : 12;
          safeApproachPressure += base * (safe ? 1 : 0.35);
          if (safe) safeApproachAttackers += 1;
        }
      }
      // 敵帥の近くに安全な攻撃駒が複数いる場合、単独の接近よりも
      // 包囲を継続しやすい形として追加評価する。
      mateNet += Math.min(128, safeApproachPressure);
      if (safeApproachAttackers >= 2) {
        mateNet += Math.min(72, (safeApproachAttackers - 1) * 18 +
          (safeApproachAttackers >= 3 ? 18 : 0));
      }
    }

    // 敵陣への進出度に応じた基本ボーナスに、敵帥とのマンハッタン距離倍率を掛ける。
    // 奥3列は各+20、4列目は+10、5列目は+5。
    // 距離2以内は×1.8、3〜4は×1.35、5以上は×1.0。
    let marshalPressure = 0;
    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const stack = state.board[row][col];
        if (!stack.length || stack[stack.length - 1].side !== side) continue;
        const advance = advancement(row, side);
        const baseBonus = advance >= 6 ? 20 : advance === 5 ? 10 : advance === 4 ? 5 : 0;
        if (!baseBonus) continue;
        const distanceToEnemyMarshal = enemyMarshal
          ? Math.abs(row - enemyMarshal.row) + Math.abs(col - enemyMarshal.col)
          : 8;
        const distanceMultiplier = distanceToEnemyMarshal <= 2 ? 1.8
          : distanceToEnemyMarshal <= 4 ? 1.35 : 1.0;
        marshalPressure += baseBonus * distanceMultiplier;
      }
    }
    threats += Math.min(180, marshalPressure);

    // 敵帥が現在王手ではない場合でも、安全な移動先が少なければ詰めろに近い状態として評価。
    // 逃げ道0〜3に応じて段階的に加点し、4以上では追加点を与えない。
    if (enemyMarshalForStack) {
      if (E.isInCheck(state, enemy)) {
        const safeResponses = countSafeCheckResponses(state, enemy, enemyMoves);
        mateNet += 320 + Math.max(0, 4 - Math.min(4, safeResponses)) * 110;
      } else {
        const enemySafeEscapes = countSafeMarshalEscapes(state, enemy, enemyMoves, enemyMarshalForStack);
        mateNet += [250, 160, 90, 30, 0][Math.min(4, enemySafeEscapes)];
      }
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
    if (E.isInCheck(state, side)) kingSafety -= 8500;
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

      // 帥の位置に応じて護衛の必要枚数を変える。
      // 中央(盤内)：3枚、辺(隅以外の外周)：2枚、隅：0枚。
      // 隅では味方が0枚の場合に限り、孤立ペナルティを適用する。
      const onTopOrBottomEdge = marshal.row === 0 || marshal.row === E.SIZE - 1;
      const onLeftOrRightEdge = marshal.col === 0 || marshal.col === E.SIZE - 1;
      const isCorner = onTopOrBottomEdge && onLeftOrRightEdge;
      const isEdge = onTopOrBottomEdge || onLeftOrRightEdge;
      const requiredGuards = isCorner ? 0 : isEdge ? 2 : 3;
      if (isCorner) {
        if (nearbyFriends === 0) kingSafety -= 40;
      } else if (nearbyFriends < requiredGuards) {
        kingSafety -= (requiredGuards - nearbyFriends) * 12;
        if (nearbyFriends === 0) kingSafety -= 40;
      }

      // 帥を実際に動かした局面を作り、相手が次の手で帥を取れない移動先だけを
      // 安全な逃げ道として数える。単なる移動可能マスは逃げ道に含めない。
      const safeMarshalEscapes = countSafeMarshalEscapes(
        state, side, moveList, marshal
      );
      kingSafety += Math.min(4, safeMarshalEscapes) * 12;
      // 帥手中に安全な逃げ道が少ないほど詰みに近い。相手側の評価にも反映する。
      if (E.isInCheck(state, side)) {
        kingSafety -= Math.max(0, 4 - Math.min(4, safeMarshalEscapes)) * 450;
      }
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
      kingSafety: Math.round(kingSafety),
      mateNet: Math.round(mateNet)
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
    const signature = weightsSignature();
    const cached = breakdownCache.get(state);
    if (cached && cached.signature === signature) return cached.result;
    const first = sideBreakdown(state, "先手");
    const second = sideBreakdown(state, "後手");
    let terminal = null;
    if (state.phase === "finished" && state.winner) {
      terminal = state.winner === "先手" ? 100000000 : -100000000;
    }
    const result = {
      weights: getWeights(),
      "先手": first,
      "後手": second,
      score: terminal === null ? first.total - second.total : terminal,
      terminal
    };
    breakdownCache.set(state, { signature, result });
    return result;
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
