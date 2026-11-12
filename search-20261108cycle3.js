/* Gungi AI — iterative deepening negamax search with alpha-beta pruning.
 * Supports ordinary moves, capture/tsuke choices, and "新" reserve deployments.
 */
(() => {
  "use strict";
  const E = window.GungiEngine;
  const AI = window.GungiAI;
  if (!E || !AI) throw new Error("Rules engine and evaluator must load before search.");
  const INF = 1000000000;
  const MATE = 100000000;
  const PIECE_VALUES = AI.PIECE_VALUES;

  class SearchAbort extends Error {}
  // Reuse child positions already built while filtering legal actions. The search
  // tree treats parent positions as immutable, so this cache is safe per action.
  const appliedChildren = new WeakMap();
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const other = side => side === "先手" ? "後手" : "先手";

  // Search positions are immutable. Memoize repeated rule/evaluation queries
  // within one search only; this avoids stale entries across turns or weight updates.
  function isInCheckMemo(state, side, memo) {
    if (!memo) return E.isInCheck(state, side);
    let bySide = memo.checks.get(state);
    if (!bySide) { bySide = new Map(); memo.checks.set(state, bySide); }
    if (bySide.has(side)) { memo.checkHits += 1; return bySide.get(side); }
    const value = E.isInCheck(state, side);
    bySide.set(side, value);
    return value;
  }
  function evaluateMemo(state, side, memo) {
    if (!memo) return AI.evaluate(state, side);
    let bySide = memo.evaluations.get(state);
    if (!bySide) { bySide = new Map(); memo.evaluations.set(state, bySide); }
    if (bySide.has(side)) { memo.evaluationHits += 1; return bySide.get(side); }
    const value = AI.evaluate(state, side);
    bySide.set(side, value);
    return value;
  }

  // Legal move generation is pure for an immutable search position. Share
  // each side's move list across capture generation, checking extensions,
  // and ordinary action generation within this search.
  function legalMovesMemo(state, side, memo) {
    if (!memo) return E.generateLegalMoves(state, side);
    let bySide = memo.legalMoves.get(state);
    if (!bySide) { bySide = new Map(); memo.legalMoves.set(state, bySide); }
    if (bySide.has(side)) {
      memo.legalMoveHits += 1;
      return bySide.get(side);
    }
    const moves = E.generateLegalMoves(state, side);
    bySide.set(side, moves);
    return moves;
  }

  function cloneState(state) {
    return {
      board: state.board.map(row => row.map(stack => stack.slice())),
      hands: { "先手": state.hands["先手"].slice(), "後手": state.hands["後手"].slice() },
      history: state.history.slice(),
      turn: state.turn,
      setupTurn: state.setupTurn,
      setupDone: { ...state.setupDone },
      setupFinishPending: state.setupFinishPending,
      phase: state.phase,
      winner: state.winner,
      moveNumber: state.moveNumber
    };
  }

  function positionKey(state) {
    let key = state.turn === "先手" ? "S|" : "G|";
    for (let r = 0; r < E.SIZE; r += 1) {
      for (let c = 0; c < E.SIZE; c += 1) {
        const stack = state.board[r][c];
        key += stack.length ? stack.map(p => (p.side === "先手" ? "s" : "g") + p.id).join(".") : "-";
        key += ",";
      }
    }
    for (const side of ["先手", "後手"]) {
      key += side === "先手" ? "|H1:" : "|H2:";
      key += state.hands[side].map(p => p.id).sort((a,b) => Number(a)-Number(b)).join(".");
    }
    return key;
  }

  function actionKey(action) {
    if (!action) return "";
    if (action.type === "deploy") return "D:" + action.pieceId + ":" + action.row + ":" + action.col;
    return "M:" + action.from.row + ":" + action.from.col + ":" + action.to.row + ":" + action.to.col + ":" + action.landingMode;
  }

  // 同じ盤面に戻る循環や、同じ駒を短い間隔で往復させる手を抑える。
  // engine側のpositionKeyと同じ形式で、駒IDではなく駒種・陣営・段構成を比較する。
  function repetitionKey(state) {
    const board = state.board.map(row => row.map(stack => stack.map(piece => piece.side + ":" + piece.name)));
    const hands = {};
    for (const side of ["先手", "後手"]) {
      hands[side] = {};
      for (const piece of state.hands[side] || []) hands[side][piece.name] = (hands[side][piece.name] || 0) + 1;
    }
    return JSON.stringify({ board, hands, turn: state.turn });
  }
  function priorPositionInfo(state) {
    const key = repetitionKey(state);
    const history = state.history || [];
    let count = 0;
    let lastIndex = -1;
    // Move/deploy records store the position immediately before that action.
    // Scan all records: the latest record is also a valid prior position.
    for (let i = 0; i < history.length; i += 1) {
      if (history[i].positionKey === key) { count += 1; lastIndex = i; }
    }
    return { count, cycleLength: lastIndex >= 0 ? history.length - lastIndex : 0 };
  }
  function priorPositionCount(state) {
    return priorPositionInfo(state).count;
  }
  // 同一局面が3回目に現れたら、非王手局面では探索上の引き分けとして扱う。
  // 初回の再訪では打ち切らず、2回目の再訪（合計3回）で循環を確定する。
  // 王手中は詰み判定を優先するため、合法な応手の探索を続ける。
  function isThreefoldRepetition(state) {
    return priorPositionCount(state) >= 2;
  }
  // 過去に到達した前進位置を基準に、同じ駒が意味なく後退する動きを軽く抑える。
  // 静的な位置評価だけでは「一度進んだ駒を元へ戻す」履歴上の損失を捉えにくいため、
  // 最高到達前進度からの後退幅が増える場合だけ小さなコストを付ける。
  function historicalRetreatPenalty(state, action) {
    if (!action || action.type !== "move") return 0;
    const stack = state.board[action.from.row] && state.board[action.from.row][action.from.col];
    const piece = stack && stack[stack.length - 1];
    if (!piece || piece.id !== action.pieceId || piece.name === "帥") return 0;
    const side = piece.side;
    const advance = row => side === "先手" ? 8 - row : row;
    const currentAdvance = advance(action.from.row);
    let bestAdvance = currentAdvance;
    for (const entry of (state.history || [])) {
      if (entry.type !== "move" || !entry.piece || entry.piece.id !== piece.id) continue;
      if (entry.from && Number.isFinite(entry.from.row)) bestAdvance = Math.max(bestAdvance, advance(entry.from.row));
      if (entry.to && Number.isFinite(entry.to.row)) bestAdvance = Math.max(bestAdvance, advance(entry.to.row));
    }
    const nextAdvance = advance(action.to.row);
    const oldRetreat = Math.max(0, bestAdvance - currentAdvance);
    const nextRetreat = Math.max(0, bestAdvance - nextAdvance);
    return Math.min(120, Math.max(0, nextRetreat - oldRetreat) * 40);
  }

  // 循環の長さ別に罰則を変えると、AIが別の周期へ逃げるだけになる。
  // 盤面・持ち駒・手番が過去と一致した場合は、周期の長さに関係なく
  // 同じ基準で小さなコストを課す。王手回避や強制応手も同じ基準で扱い、
  // 戦術的に必要な循環を禁止しない。
  function repeatedPositionPenalty(state) {
    const info = priorPositionInfo(state);
    if (!info.count) return 0;
    return Math.min(900, 260 + Math.max(0, info.count - 1) * 180);
  }

  function antiLoopPenalty(state, action) {
    if (!action) return 0;
    const child = applyAction(state, action);
    return child ? repeatedPositionPenalty(child) : 0;
  }
  function searchContextKey(state) {
    const recent = state.history.slice(-16).map(entry => entry.type === "move"
      ? [entry.piece && entry.piece.id, entry.from && entry.from.row, entry.from && entry.from.col,
         entry.to && entry.to.row, entry.to && entry.to.col, entry.landingMode].join(":")
      : entry.type).join("|");
    const repetition = priorPositionInfo(state);
    return positionKey(state) + "|r" + repetition.count + "|c" + repetition.cycleLength + "|h" + recent;
  }

  function deploymentPriority(state, side, piece, row, col) {
    const center = 8 - (Math.abs(row - 4) + Math.abs(col - 4));
    const stack = state.board[row][col];
    const ownStack = stack.length > 0;
    const enemyDistance = side === "先手" ? row : 8 - row;
    const advance = side === "先手" ? 8 - row : row;
    const value = PIECE_VALUES[piece.name] || 0;
    return center * 5 + advance * 1.4 + value * 0.025 + (ownStack ? 7 : 0) - enemyDistance * 0.15;
  }

  function generateActions(state, side, maxDeployCandidates, detectWinningCapture = true, memo = null) {
    const actions = [];
    const moves = legalMovesMemo(state, side, memo);
    for (const move of moves) {
      const target = state.board[move.to.row][move.to.col];
      if (!target.length) {
        actions.push({ type: "move", from: move.from, to: move.to, landingMode: "capture", pieceId: move.piece.id });
      } else {
        const top = target[target.length - 1];
        if (top.side !== side) {
          actions.push({ type: "move", from: move.from, to: move.to, landingMode: "capture", pieceId: move.piece.id });
          if (target.length < 3) actions.push({ type: "move", from: move.from, to: move.to, landingMode: "tsuke", pieceId: move.piece.id });
        } else if (target.length < 3) {
          actions.push({ type: "move", from: move.from, to: move.to, landingMode: "tsuke", pieceId: move.piece.id });
        }
      }
    }

    // "新" is a real turn in this ruleset. Keep a diversified shortlist to
    // avoid an enormous branching factor while still considering every type.
    const reserve = state.hands[side] || [];
    const seenNames = new Set();
    const uniquePieces = reserve.filter(piece => {
      if (seenNames.has(piece.name)) return false;
      seenNames.add(piece.name);
      return true;
    });
    const inCheck = isInCheckMemo(state, side, memo);
    const deployments = [];
    // 通常局面では各駒種の上位2候補だけを保持する。
    // 旧実装は全マス×全駒種の候補を生成・整列してから捨てていたため、
    // 静止探索で大量に呼ばれると候補生成が探索時間を圧迫していた。
    // 帥手中は合い駒の見落としを防ぐため、従来どおり全候補を列挙する。
    const perPieceTop = inCheck ? null : new Map();
    const front = E.getFrontmostFriendlyRow(state, side);
    const boundary = side === "先手"
      ? Math.min(front === null ? 6 : front, 6)
      : Math.max(front === null ? 2 : front, 2);
    for (let row = 0; row < E.SIZE; row += 1) {
      if (side === "先手" ? row < boundary : row > boundary) continue;
      for (let col = 0; col < E.SIZE; col += 1) {
        const stack = state.board[row][col];
        if (stack.length >= 3) continue;
        const top = stack.length ? stack[stack.length - 1] : null;
        if (top && (top.side !== side || top.name === "帥")) continue;
        for (const piece of uniquePieces) {
          const candidate = {
            type: "deploy", row, col, pieceId: piece.id, pieceName: piece.name,
            priority: deploymentPriority(state, side, piece, row, col)
          };
          if (inCheck) {
            deployments.push(candidate);
          } else {
            const bucket = perPieceTop.get(piece.name) || [];
            if (bucket.length < 2) {
              bucket.push(candidate);
              bucket.sort((a,b) => b.priority - a.priority);
            } else if (candidate.priority > bucket[1].priority) {
              bucket[1] = candidate;
              bucket.sort((a,b) => b.priority - a.priority);
            }
            perPieceTop.set(piece.name, bucket);
          }
        }
      }
    }
    if (inCheck) {
      actions.push(...deployments.map(({priority, ...action}) => action));
    } else {
      const selected = [...perPieceTop.values()].flat();
      selected.sort((a,b) => b.priority - a.priority);
      actions.push(...selected.slice(0, maxDeployCandidates).map(({priority, ...action}) => action));
    }

    // A legal immediate Marshal capture always overrides every other move.
    // Test the real engine transition so stack/capture rules are respected.
    if (detectWinningCapture) {
      const winningCaptures = [];
      for (const action of actions) {
        if (action.type !== "move" || action.landingMode !== "capture") continue;
        const trial = cloneState(state);
        trial.turn = side;
        const result = E.movePiece(
          trial,
          action.from.row, action.from.col,
          action.to.row, action.to.col,
          "capture"
        );
        if (result.ok && result.gameOver && result.winner === side) {
          winningCaptures.push(action);
        }
      }
      if (winningCaptures.length) return winningCaptures;
    }
    return actions;
  }

  function applyAction(state, action) {
    const cached = appliedChildren.get(action);
    if (cached && cached.parent === state) return cached.child;
    const next = cloneState(state);
    let result;
    if (action.type === "deploy") {
      result = E.deployPiece(next, action.row, action.col, next.turn, action.pieceId);
    } else {
      result = E.movePiece(next, action.from.row, action.from.col, action.to.row, action.to.col, action.landingMode);
    }
    if (!result || !result.ok) return null;
    appliedChildren.set(action, { parent: state, child: next });
    return next;
  }

  // 着手後に自分の帥が相手の捕獲可能範囲へ入る手を除外する。
  // すでに帥手を受けている場合だけでなく、遮蔽物を動かして
  // 相手の射線・移動範囲を帥まで通してしまう手も候補にしない。
  // 移動・捕獲・ツケ・「新」による合い駒を同じ基準で検査する。
  function getSearchActions(state, side, maxDeployCandidates, memo = null) {
    const actions = generateActions(state, side, maxDeployCandidates, true, memo);
    const inCheck = isInCheckMemo(state, side, memo);
    const safeActions = [];
    for (const action of actions) {
      const child = applyAction(state, action);
      // Keep the already-created child position attached to this action for search.
      // 自分の帥を危険にさらさない手を先に並べる。
      // ただし、ユーザー指定により帥手を解消しない合法手も候補から除外しない。
      if (child && (
        (child.phase === "finished" && child.winner === side) ||
        !isInCheckMemo(child, side, memo)
      )) {
        safeActions.push(action);
      }
    }
    if (inCheck) {
      // 帥手中は、実際に帥手を解消できた手だけが合法。
      // 応手がなければ空配列を返し、探索側で即詰みとして扱う。
      return safeActions;
    }
    // 通常局面では自分の帥を危険にさらす手を除外する。
    return safeActions.length ? safeActions : actions;
  }

  function isQuietAction(state, action) {
    if (action.type === "deploy") return true;
    const target = state.board[action.to.row][action.to.col];
    return !target.length || target[target.length - 1].side === state.turn;
  }

  function orderActions(state, actions, ttMove, ply = 0, killers = null, historyScores = null) {
    const preferred = actionKey(ttMove);
    const killerList = killers && killers.get(ply) || [];
    return actions.map(action => {
      let score = actionKey(action) === preferred ? 100000000 : 0;
      if (action.type === "deploy") {
        const piece = state.hands[state.turn].find(p => p.id === action.pieceId);
        if (piece) score += deploymentPriority(state, state.turn, piece, action.row, action.col) * 3;
      } else {
        if (isQuietAction(state, action)) {
          const key = actionKey(action);
          const killerIndex = killerList.indexOf(key);
          if (killerIndex >= 0) score += 42000 - killerIndex * 4000;
          if (historyScores) score += historyScores.get(key) || 0;
        }
        const target = state.board[action.to.row][action.to.col];
        const attacker = state.board[action.from.row][action.from.col].slice(-1)[0];
        if (target.length && target[target.length - 1].side !== state.turn) {
          if (action.landingMode === "capture") {
            const hasFriendlyUnderneath = target.some(piece => piece.side === state.turn);
            const captured = hasFriendlyUnderneath
              ? [target[target.length - 1]]
              : target.filter(piece => piece.side !== state.turn);
            const capturedValue = captured.reduce((sum, piece) => sum + (PIECE_VALUES[piece.name] || 0), 0);
            score += capturedValue * 12 - (PIECE_VALUES[attacker.name] || 0);
          } else {
            // ツケは捕獲ではない。捕獲手と混同せず、候補として少しだけ優先する。
            score += 25;
          }
        }
        if (attacker && attacker.name === "帥") score += 15;
      }
      return { action, score };
    }).sort((a,b) => b.score - a.score).map(item => item.action);
  }

  // 静止探索用：通常探索の末端でも、実際に駒を取る手だけを追加で読む。
  // 「取り合いの途中」で評価を止める水平線効果を軽減する。
  function generateCaptureActions(state, side, memo = null) {
    const actions = [];
    for (const move of legalMovesMemo(state, side, memo)) {
      const target = state.board[move.to.row][move.to.col];
      if (!target.length || target[target.length - 1].side === side) continue;
      actions.push({
        type: "move",
        from: move.from,
        to: move.to,
        landingMode: "capture",
        pieceId: move.piece.id
      });
    }
    return actions;
  }

  // 静止探索用：通常の捕獲に加え、帥手を掛ける静かな手も読む。
  // 連続王手からの詰み筋・逃げ道封鎖を探索の末端で見落としにくくする。
  function generateCheckingActions(state, side, maxDeployCandidates, memo = null,
    ply = 0, killers = null, historyScores = null, inspectionLimit = 48) {
    const checks = [];
    // This helper is called only when the moving side is not in check.
    // Captures are supplied separately by generateCaptureActions().
    // Quiet checks are an optional quiescence extension, unlike forced
    // evasions and captures. Rank candidates first and inspect only a bounded
    // prefix so a position with many legal quiet moves does not spend most of
    // its search budget proving that dozens of them are not checks.
    const actions = generateActions(state, side, maxDeployCandidates, false, memo)
      .filter(action => isQuietAction(state, action));
    const ordered = orderActions(state, actions, null, ply, killers, historyScores);
    const inspected = ordered.slice(0, Math.max(1, inspectionLimit));
    for (const action of inspected) {
      const child = applyAction(state, action);
      if (!child || child.phase === "finished") continue;
      if (isInCheckMemo(child, side, memo)) continue;
      if (isInCheckMemo(child, child.turn, memo)) checks.push(action);
    }
    return { checks, seen: actions.length, inspected: inspected.length };
  }

  function findBestMove(state, options = {}) {
    return new Promise((resolve, reject) => {
      (async () => {
        if (!state || state.phase !== "move" || state.phase === "finished") {
          throw new TypeError("移動モードの有効な局面を指定してください。");
        }
        const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth) || 4));
        const timeMs = Math.max(100, Math.min(15000, Number(options.timeMs) || 2200));
        const maxNodes = Math.max(1000, Math.min(1000000, Number(options.maxNodes) || 90000));
        const maxDeployCandidates = Math.max(0, Math.min(24, Number(options.maxDeployCandidates) || 12));
        const maxTTEntries = Math.max(2000, Math.min(100000, Number(options.maxTTEntries) || 30000));
        const started = now();
        const evaluationCacheStart = AI.getEvaluationCacheStats ? AI.getEvaluationCacheStats().hits : 0;
        const deadline = started + timeMs;
        const root = cloneState(state);
        const table = new Map();
        const stats = { nodes: 0, qnodes: 0, cutoffs: 0, ttHits: 0,
          q: { inCheckNodes: 0, quietNodes: 0, standPatEvaluations: 0,
            standPatCutoffs: 0, qplyLimitStops: 0, adaptiveQuietStops: 0, repetitionStops: 0,
            terminalNodes: 0, evasionActions: 0, captureActions: 0,
            checkingActions: 0, checkingCandidatesSeen: 0, checkingCandidatesInspected: 0,
            noTacticalActions: 0, appliedActions: 0,
            evasionLimitNodes: 0, timingSamples: 0,
            generationMs: 0, orderingMs: 0, evaluationMs: 0,
            checkMs: 0, applyMs: 0 }
        };
        const memo = { checks: new WeakMap(), evaluations: new WeakMap(), legalMoves: new WeakMap(), checkHits: 0, evaluationHits: 0, legalMoveHits: 0 };
        // Killer moves and history scores improve ordering of quiet moves.
        // They are local to one search and never alter legal move generation.
        const killers = new Map();
        const historyScores = new Map();
        function rememberQuietCutoff(position, action, depth, ply) {
          if (!isQuietAction(position, action)) return;
          const key = actionKey(action);
          const list = killers.get(ply) || [];
          if (!list.includes(key)) {
            list.unshift(key);
            if (list.length > 2) list.length = 2;
            killers.set(ply, list);
          }
          historyScores.set(key, Math.min(200000, (historyScores.get(key) || 0) + depth * depth * 32));
        }
        const checkStop = () => {
          if (stats.nodes >= maxNodes || now() >= deadline) throw new SearchAbort();
        };

        function store(key, entry) {
          if (table.size >= maxTTEntries) {
            const first = table.keys().next();
            if (!first.done) table.delete(first.value);
          }
          table.set(key, entry);
        }

        function quiescence(position, alpha, beta, ply, qply) {
          stats.nodes += 1;
          stats.qnodes += 1;
          const q = stats.q;
          // Timing is sampled once per 32 qnodes to keep instrumentation overhead low.
          const sampled = (stats.qnodes & 31) === 1;
          const qStarted = sampled ? now() : 0;
          if (sampled) q.timingSamples++;
          if ((stats.nodes & 127) === 0) checkStop();
          if (position.phase === "finished") {
            q.terminalNodes++;
            return position.winner === position.turn ? MATE - ply : -MATE + ply;
          }

          let t = sampled ? now() : 0;
          const inCheck = isInCheckMemo(position, position.turn, memo);
          if (sampled) q.checkMs += now() - t;
          if (inCheck) q.inCheckNodes++; else q.quietNodes++;
          if (!inCheck && isThreefoldRepetition(position)) {
            q.repetitionStops++;
            return 0;
          }
          t = sampled ? now() : 0;
          const standPat = inCheck ? -INF : evaluateMemo(position, position.turn, memo);
          if (sampled) q.evaluationMs += now() - t;
          if (!inCheck) {
            q.standPatEvaluations++;
            const alphaBeforeStandPat = alpha;
            if (standPat >= beta) { q.standPatCutoffs++; return standPat; }
            if (standPat > alpha) alpha = standPat;
            // Stable quiet positions stop after two tactical plies when the
            // stand-pat score is close to the incoming alpha. This keeps early
            // captures and the opponent's immediate recapture, while avoiding
            // expensive speculative capture chains in quiet positions.
            // Check evasions are handled above and are never pruned here.
            if (qply >= 2 && standPat >= alphaBeforeStandPat - 120) {
              q.adaptiveQuietStops++;
              return alpha;
            }
            if (qply >= 5) { q.qplyLimitStops++; return alpha; }
          }

          // 帥手中は静止評価で打ち切らず、合法な全応手を調べる。
          // 応手がなければ、その場で詰みとして扱う。
          t = sampled ? now() : 0;
          let tactical;
          if (inCheck) {
            tactical = getSearchActions(position, position.turn, maxDeployCandidates, memo);
            q.evasionActions += tactical.length;
          } else {
            const captures = generateCaptureActions(position, position.turn, memo);
            q.captureActions += captures.length;
            if (qply >= 1) tactical = captures;
            else {
              const captureKeys = new Set(captures.map(actionKey));
              const checkingScan = generateCheckingActions(
                position, position.turn, maxDeployCandidates, memo, ply, killers, historyScores, 48
              );
              const checks = checkingScan.checks.filter(action => !captureKeys.has(actionKey(action)));
              q.checkingCandidatesSeen = (q.checkingCandidatesSeen || 0) + checkingScan.seen;
              q.checkingCandidatesInspected = (q.checkingCandidatesInspected || 0) + checkingScan.inspected;
              q.checkingActions += checks.length;
              // Quiet checks can be numerous in Gungi because reserve deployments
              // and stacked movement create many checking continuations. Keep all
              // captures, but search only the four best-ordered quiet checks at
              // the first quiescence ply. This is deliberately limited to the
              // optional checking extension; forced check evasions remain exhaustive.
              const orderedChecks = orderActions(position, checks, null, ply, killers, historyScores);
              const selectedChecks = orderedChecks.slice(0, 4);
              q.checkingCandidatesBeforeLimit = (q.checkingCandidatesBeforeLimit || 0) + checks.length;
              q.checkingCandidatesAfterLimit = (q.checkingCandidatesAfterLimit || 0) + selectedChecks.length;
              q.checkingCandidatesPruned = (q.checkingCandidatesPruned || 0) + Math.max(0, checks.length - selectedChecks.length);
              tactical = captures.concat(selectedChecks);
            }
          }
          if (sampled) q.generationMs += now() - t;
          t = sampled ? now() : 0;
          const ordered = orderActions(position, tactical, null, ply, killers, historyScores);
          if (sampled) q.orderingMs += now() - t;
          if (inCheck && !ordered.length) return -MATE + ply;
          if (!ordered.length) q.noTacticalActions++;
          // 長い連続王手では探索資源を守りつつ、少なくとも王手回避手を
          // 1手実行してから評価する。王手中の静止評価による誤判定を防ぐ。
          if (inCheck && qply >= 10) {
            q.evasionLimitNodes++;
            let bestEvasion = -INF;
            for (const action of ordered) {
              checkStop();
              t = sampled ? now() : 0;
              const child = applyAction(position, action);
              if (sampled) q.applyMs += now() - t;
              q.appliedActions++;
              if (!child) continue;
              t = sampled ? now() : 0;
              const score = child.phase === "finished"
                ? (child.winner === position.turn ? MATE - ply - 1 : -MATE + ply + 1)
                : -evaluateMemo(child, child.turn, memo);
              if (sampled) q.evaluationMs += now() - t;
              if (score > bestEvasion) bestEvasion = score;
            }
            return bestEvasion === -INF ? -MATE + ply : bestEvasion;
          }
          for (const action of ordered) {
            checkStop();
            t = sampled ? now() : 0;
            const child = applyAction(position, action);
            if (sampled) q.applyMs += now() - t;
            q.appliedActions++;
            if (!child) continue;
            const score = -quiescence(child, -beta, -alpha, ply + 1, qply + 1);
            if (score >= beta) return score;
            if (score > alpha) alpha = score;
          }
          return alpha;
        }

        function negamax(position, depth, alpha, beta, ply) {
          stats.nodes += 1;
          if ((stats.nodes & 127) === 0) checkStop();
          if (position.phase === "finished") {
            return position.winner === position.turn ? MATE - ply : -MATE + ply;
          }
          if (!isInCheckMemo(position, position.turn, memo) && isThreefoldRepetition(position)) return 0;
          // 深さ0でも帥手中なら通常の1手探索を延長し、全ての回避手を読む。
          // これにより「評価値は高いが次の手で帥を取られる」手を避ける。
          if (depth <= 0) {
            if (!isInCheckMemo(position, position.turn, memo)) return quiescence(position, alpha, beta, ply, 0);
            depth = 1;
          }

          const key = searchContextKey(position);
          const originalAlpha = alpha;
          const originalBeta = beta;
          const cached = table.get(key);
          if (cached && cached.depth >= depth) {
            stats.ttHits += 1;
            if (cached.flag === "exact") return cached.score;
            if (cached.flag === "lower") alpha = Math.max(alpha, cached.score);
            else if (cached.flag === "upper") beta = Math.min(beta, cached.score);
            if (alpha >= beta) return cached.score;
          }
          const actions = orderActions(position, getSearchActions(position, position.turn, maxDeployCandidates, memo), cached && cached.best, ply, killers, historyScores);
          if (!actions.length) return isInCheckMemo(position, position.turn, memo) ? -MATE + ply : evaluateMemo(position, position.turn, memo);
          let bestScore = -INF;
          let bestAction = null;
          for (let index = 0; index < actions.length; index += 1) {
            const action = actions[index];
            checkStop();
            const child = applyAction(position, action);
            if (!child) continue;
            let score;
            // 王手を掛ける手は静かな手に見えても戦術手。LMRで浅く読まず、
            // 王手筋・連続王手・帥の逃げ道封鎖を通常の深さで検証する。
            const givesCheck = child.phase !== "finished" && isInCheckMemo(child, child.turn, memo);
            const quiet = isQuietAction(position, action) &&
              !isInCheckMemo(position, position.turn, memo) && !givesCheck;
            const reduction = index >= 4 && depth >= 3 && quiet ? 1 + (index >= 10 && depth >= 5 ? 1 : 0) : 0;
            // 同じ局面へ戻る複数駒の循環にも、駒単位の往復とは別に罰点を与える。
            const penalty = repeatedPositionPenalty(child);
            // 王手回避を妨げない範囲で、過去に進出した駒を無意味に後退させる手を抑える。
            const retreatPenalty = isInCheckMemo(position, position.turn, memo) || givesCheck
              ? 0 : historicalRetreatPenalty(position, action);
            if (index === 0) {
              score = -negamax(child, depth - 1, -beta, -alpha, ply + 1) - penalty - retreatPenalty;
            } else {
              // PVS + Late Move Reductions: late quiet moves are first searched
              // one or two plies shallower; an alpha improvement triggers a full-depth re-search.
              const reducedDepth = Math.max(0, depth - 1 - reduction);
              score = -negamax(child, reducedDepth, -alpha - 1, -alpha, ply + 1) - penalty - retreatPenalty;
              if (reduction && score > alpha) {
                score = -negamax(child, depth - 1, -alpha - 1, -alpha, ply + 1) - penalty - retreatPenalty;
              }
              if (score > alpha && score < beta) {
                score = -negamax(child, depth - 1, -beta, -alpha, ply + 1) - penalty - retreatPenalty;
              }
            }
            if (score > bestScore) {
              bestScore = score;
              bestAction = action;
            }
            if (score > alpha) alpha = score;
            if (alpha >= beta) {
              stats.cutoffs += 1;
              rememberQuietCutoff(position, action, depth, ply);
              break;
            }
          }
          if (!bestAction) return evaluateMemo(position, position.turn, memo);
          const flag = bestScore <= originalAlpha ? "upper" : bestScore >= originalBeta ? "lower" : "exact";
          store(key, { depth, score: bestScore, flag, best: bestAction });
          return bestScore;
        }

        function searchRoot(root, depth, previousBest, alphaStart = -INF, betaStart = INF) {
          const key = searchContextKey(root);
          const cached = table.get(key);
          const actions = orderActions(root, getSearchActions(root, root.turn, maxDeployCandidates, memo), previousBest || (cached && cached.best), 0, killers, historyScores);
          let alpha = alphaStart;
          const beta = betaStart;
          let bestScore = -INF;
          let bestAction = null;
          const rootCandidates = [];
          for (let index = 0; index < actions.length; index += 1) {
            const action = actions[index];
            checkStop();
            const child = applyAction(root, action);
            if (!child) continue;
            let score;
            const retreatPenalty = isInCheckMemo(root, root.turn, memo) ||
              (child.phase !== "finished" && isInCheckMemo(child, child.turn, memo))
              ? 0 : historicalRetreatPenalty(root, action);
            if (index === 0) {
              score = -negamax(child, depth - 1, -beta, -alpha, 1) -
                repeatedPositionPenalty(child) - retreatPenalty;
            } else {
              score = -negamax(child, depth - 1, -alpha - 1, -alpha, 1) - repeatedPositionPenalty(child) - retreatPenalty;
              if (score > alpha && score < beta) {
                score = -negamax(child, depth - 1, -beta, -alpha, 1) -
                  repeatedPositionPenalty(child) - retreatPenalty;
              }
            }
            rootCandidates.push({ action: actionKey(action), score: Number.isFinite(score) ? Math.round(score) : null });
            if (score > bestScore) {
              bestScore = score;
              bestAction = action;
            }
            if (score > alpha) alpha = score;
            if (alpha >= beta) break;
          }
          if (bestAction) store(key, { depth, score: bestScore, flag: "exact", best: bestAction });
          rootCandidates.sort((a,b) => (b.score ?? -INF) - (a.score ?? -INF));
          return { bestAction, score: bestScore, rootCandidates: rootCandidates.slice(0, 5) };
        }

        let completed = null;
        let previousBest = null;
        let previousScore = 0;
        const fallbackActions = orderActions(root,
          getSearchActions(root, root.turn, maxDeployCandidates, memo), null, 0, killers, historyScores);
        const fallback = fallbackActions[0] || null;
        if (!fallback) { resolve({ bestMove: null, score: evaluateMemo(root, root.turn, memo), depth: 0, nodes: 0, elapsedMs: now() - started, rootCandidates: [], rootCandidateSource: "none" }); return; }
        function scoreFallbackRootCandidates() {
          const scored = [];
          // 深い探索が時間切れになる局面でも、候補手の比較材料を必ず残す。
          // これは探索スコアではなく、上位12合法手を1手進めた静的評価である。
          for (const action of fallbackActions.slice(0, 12)) {
            const child = applyAction(root, action);
            if (!child) continue;
            let score = child.phase === "finished"
              ? (child.winner === root.turn ? MATE : -MATE)
              : evaluateMemo(child, root.turn, memo);
            score -= repeatedPositionPenalty(child);
            if (!isInCheckMemo(root, root.turn, memo) &&
                !(child.phase !== "finished" && isInCheckMemo(child, child.turn, memo))) {
              score -= historicalRetreatPenalty(root, action);
            }
            scored.push({ action: actionKey(action), score: Number.isFinite(score) ? Math.round(score) : null });
          }
          scored.sort((a,b) => (b.score ?? -INF) - (a.score ?? -INF));
          return scored.slice(0, 5);
        }
        for (let depth = 1; depth <= maxDepth; depth += 1) {
          try {
            checkStop();
            // Aspiration window reduces root-node work after the first completed iteration.
            const window = depth >= 2 && completed ? 90 : INF;
            let result = searchRoot(root, depth, previousBest,
              window === INF ? -INF : previousScore - window,
              window === INF ? INF : previousScore + window);
            if (window !== INF && (result.score <= previousScore - window || result.score >= previousScore + window)) {
              result = searchRoot(root, depth, previousBest);
            }
            if (result.bestAction) {
              completed = { ...result, depth };
              previousBest = result.bestAction;
              previousScore = result.score;
            }
          } catch (error) {
            if (!(error instanceof SearchAbort)) throw error;
            break;
          }
          if (typeof options.onProgress === "function") {
            options.onProgress({ depth, nodes: stats.nodes, elapsedMs: Math.round(now() - started), score: completed ? completed.score : 0 });
          }
          if (now() >= deadline || stats.nodes >= maxNodes) break;
          await new Promise(done => setTimeout(done, 0));
        }
        const result = completed || { bestAction: fallback, score: evaluateMemo(root, root.turn, memo), depth: 0 };
        const searchedCandidates = result.rootCandidates || [];
        const rootCandidateSource = searchedCandidates.length ? "search" : "static-fallback";
        const rootCandidates = searchedCandidates.length ? searchedCandidates : scoreFallbackRootCandidates();
        resolve({
          bestMove: result.bestAction,
          score: result.score,
          depth: result.depth,
          nodes: stats.nodes,
          quiescenceNodes: stats.qnodes,
          quiescenceDiagnostics: { ...stats.q },
          cutoffs: stats.cutoffs,
          transpositionHits: stats.ttHits,
          checkCacheHits: memo.checkHits,
          evaluationCacheHits: memo.evaluationHits,
          positionEvaluationCacheHits: AI.getEvaluationCacheStats
            ? AI.getEvaluationCacheStats().hits - evaluationCacheStart : 0,
          legalMoveCacheHits: memo.legalMoveHits,
          elapsedMs: Math.round(now() - started),
          rootCandidates,
          rootCandidateSource
        });
      })().catch(reject);
    });
  }


  // 初期配置候補。自陣の駒があるマスも2段目・3段目として列挙する。
  function generateSetupActions(state) {
    if (!state || state.phase !== "setup") return [];
    const side = state.setupTurn;
    const hand = state.hands[side] || [];
    const hasPlacedMarshal = state.history.some(entry =>
      entry.type === "place" && entry.side === side && entry.piece.name === "帥"
    );
    const unique = new Set();
    const pieces = hand.filter(piece => {
      if (!hasPlacedMarshal && piece.name !== "帥") return false;
      if (unique.has(piece.name)) return false;
      unique.add(piece.name);
      return true;
    });
    const actions = [];
    const hasPlacedAnyPiece = state.history.some(entry => entry.type === "place" && entry.side === side);
    for (const piece of pieces) {
      for (let row = 0; row < E.SIZE; row += 1) {
        for (let col = 0; col < E.SIZE; col += 1) {
          if (!hasPlacedAnyPiece && piece.name === "帥" && row !== (side === "先手" ? E.SIZE - 1 : 0)) continue;
          if (!E.canPlacePiece(state, row, col, piece)) continue;
          const stack = state.board[row][col];
          actions.push({
            type: "setup", row, col, pieceId: piece.id, pieceName: piece.name,
            targetLayer: stack.length + 1, stacking: stack.length > 0
          });
        }
      }
    }
    return actions;
  }

  async function findBestSetupPlacement(state, options = {}) {
    if (!state || state.phase !== "setup") throw new TypeError("初期配置中の局面を指定してください。");
    const side=state.setupTurn,enemy=other(side),started=now();
    const timeMs=Math.max(100,Math.min(5000,Number(options.timeMs)||2400)),deadline=started+timeMs;
    const maxNodes=Math.max(40,Math.min(6000,Number(options.maxNodes)||2800));
    const rootLimit=Math.max(8,Math.min(80,Number(options.rootCandidateLimit)||36));
    const replyLimit=Math.max(4,Math.min(32,Number(options.replyCandidateLimit)||14));
    const rootBeamSize=Math.max(2,Math.min(16,Number(options.rootBeam)||10));
    const replyBeamSize=Math.max(2,Math.min(10,Number(options.replyBeam)||6));
    let nodes=0,best=null,bestScore=-INF,bestGain=-INF,completed=0;
    const baseScore=AI.evaluate(state,side);
    function variants(position,actingSide,limit){
      const actions=generateSetupActions(position),hasPlaced=position.history.some(h=>h.type==="place"&&h.side===actingSide);
      const canFinish=options.allowFinish!==false&&hasPlaced&&!position.setupFinishPending&&
        position.history.some(h=>h.type==="place"&&h.side===actingSide&&h.piece.name==="帥");
      const out=[];
      for(const action of actions){
        const piece=position.hands[actingSide].find(p=>p.id===action.pieceId);if(!piece)continue;
        const finishOptions=canFinish?(position.hands[actingSide].length===1?[true]:[false,true]):[false];
        for(const finishFirst of finishOptions){
          const next=cloneState(position);
          if(finishFirst&&!E.finishSetup(next,actingSide).ok)continue;
          const placed=E.placePiece(next,action.row,action.col,actingSide,action.pieceId);
          if(!placed.ok||E.isInCheck(next,actingSide))continue;
          // Training and paired verification can request neutral starting positions:
          // preserve own-king safety while preferring placements that do not begin
          // the opponent's game already in check.
          if(options.requireNoCheckBoth&&E.isInCheck(next,other(actingSide)))continue;
          const priority=deploymentPriority(position,actingSide,piece,action.row,action.col)*0.08+
            (action.stacking?1.5*action.targetLayer:0);
          out.push({action,finishFirst,next,priority,score:-INF});
        }
      }
      out.sort((a,b)=>b.priority-a.priority);
      return out.slice(0,limit);
    }
    // When the first side commits to 済, the opponent alone controls the
    // remainder of setup. Follow a bounded beam of opponent placements all
    // the way to the mandatory final placement, rather than judging only one reply.
    function completeOpponentSetup(startState){
      let frontier=[{state:startState,score:AI.evaluate(startState,side)}];
      let bestTerminal=null,depth=0;
      while(frontier.length&&depth<30&&nodes<maxNodes&&now()<deadline){
        const next=[];
        for(const item of frontier){
          if(item.state.phase==="move"){
            if(bestTerminal===null||item.score<bestTerminal)bestTerminal=item.score;
            continue;
          }
          if(item.state.phase!=="setup"||item.state.setupTurn!==enemy)continue;
          const replies=variants(item.state,enemy,replyLimit);
          for(const reply of replies){
            if(nodes>=maxNodes||now()>=deadline)break;
            reply.score=AI.evaluate(reply.next,side)+reply.priority;
            nodes++;
            if(reply.next.phase==="move"){
              if(bestTerminal===null||reply.score<bestTerminal)bestTerminal=reply.score;
            }else next.push({state:reply.next,score:reply.score});
          }
          if(nodes>=maxNodes||now()>=deadline)break;
        }
        next.sort((a,b)=>a.score-b.score);
        frontier=next.slice(0,replyBeamSize);
        depth++;
      }
      const unfinished=frontier.length?Math.min(...frontier.map(item=>item.score)):INF;
      return {score:bestTerminal===null?unfinished:bestTerminal,completed:bestTerminal!==null,depth};
    }
    const root=variants(state,side,rootLimit);
    if(!root.length)return {bestMove:null,score:baseScore,depth:0,nodes,elapsedMs:Math.round(now()-started),finishRecommended:false};
    const scoredRoot=[];
    for(const candidate of root){
      if(nodes>=maxNodes||now()>=deadline)break;
      candidate.score=AI.evaluate(candidate.next,side)+candidate.priority;
      nodes++;scoredRoot.push(candidate);
    }
    scoredRoot.sort((a,b)=>b.score-a.score);
    for(const candidate of scoredRoot.slice(0,rootBeamSize)){
      if(nodes>=maxNodes||now()>=deadline)break;
      let score=candidate.score;
      const replyState=candidate.next;
      if(candidate.finishFirst&&replyState.phase==="setup"&&replyState.setupTurn===enemy&&nodes<maxNodes&&now()<deadline){
        const completion=completeOpponentSetup(replyState);
        score=completion.score;
      }else if(replyState.phase==="setup"&&replyState.setupTurn===enemy&&nodes<maxNodes&&now()<deadline){
        const replies=variants(replyState,enemy,replyLimit),scoredReplies=[];
        for(const reply of replies){
          if(nodes>=maxNodes||now()>=deadline)break;
          reply.score=AI.evaluate(reply.next,side)+reply.priority;
          nodes++;scoredReplies.push(reply);
        }
        scoredReplies.sort((a,b)=>a.score-b.score);
        if(scoredReplies.length)score=scoredReplies[0].score;
      }
      if(score>bestScore){bestScore=score;bestGain=score-baseScore;best={...candidate.action,finishFirst:candidate.finishFirst};}
      completed++;
      if(typeof options.onProgress==="function"&&completed%2===0)
        options.onProgress({nodes,score:bestScore,elapsedMs:Math.round(now()-started),depth:2});
      if(completed%2===0)await new Promise(done=>setTimeout(done,0));
    }
    return {bestMove:best,score:bestScore,gain:bestGain,finishRecommended:!!(best&&best.finishFirst),
      deployedCount:state.history.filter(h=>h.type==="place"&&h.side===side).length,
      depth:completed?2:1,nodes,candidateCount:generateSetupActions(state).length,
      stackingCandidates:root.filter(x=>x.action.stacking).length,elapsedMs:Math.round(now()-started)};
  }

  window.GungiSearch = Object.freeze({
    findBestMove,
    findBestSetupPlacement,
    generateSetupActions,
    generateActions: (state, options = {}) => generateActions(state, state.turn, options.maxDeployCandidates || 12),
    getSearchActions: (state, options = {}) => getSearchActions(state, state.turn, options.maxDeployCandidates || 12),
    // Exposed for deterministic regression tests of history-sensitive TT keys.
    getSearchContextKey: searchContextKey,
    getAntiLoopPenalty: antiLoopPenalty,
    getHistoricalRetreatPenalty: historicalRetreatPenalty,
    getRepeatedPositionPenalty: repeatedPositionPenalty,
    isThreefoldRepetition,
    cloneState
  });
})();
