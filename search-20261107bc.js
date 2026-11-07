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
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const other = side => side === "先手" ? "後手" : "先手";

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

  function deploymentPriority(state, side, piece, row, col) {
    const center = 8 - (Math.abs(row - 4) + Math.abs(col - 4));
    const stack = state.board[row][col];
    const ownStack = stack.length > 0;
    const enemyDistance = side === "先手" ? row : 8 - row;
    const advance = side === "先手" ? 8 - row : row;
    const value = PIECE_VALUES[piece.name] || 0;
    return center * 5 + advance * 1.4 + value * 0.025 + (ownStack ? 7 : 0) - enemyDistance * 0.15;
  }

  function generateActions(state, side, maxDeployCandidates) {
    const actions = [];
    const moves = E.generateLegalMoves(state, side);
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
    const deployments = [];
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
          deployments.push({
            type: "deploy", row, col, pieceId: piece.id, pieceName: piece.name,
            priority: deploymentPriority(state, side, piece, row, col)
          });
        }
      }
    }
    deployments.sort((a,b) => b.priority - a.priority);
    const perPiece = new Map();
    const selected = [];
    for (const action of deployments) {
      const count = perPiece.get(action.pieceName) || 0;
      if (count >= 2) continue;
      perPiece.set(action.pieceName, count + 1);
      selected.push(action);
    }
    selected.sort((a,b) => b.priority - a.priority);
    actions.push(...selected.slice(0, maxDeployCandidates).map(({priority, ...action}) => action));

    // A legal immediate Marshal capture always overrides every other move.
    // Test the real engine transition so stack/capture rules are respected.
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
    return actions;
  }

  function applyAction(state, action) {
    const next = cloneState(state);
    let result;
    if (action.type === "deploy") {
      result = E.deployPiece(next, action.row, action.col, next.turn, action.pieceId);
    } else {
      result = E.movePiece(next, action.from.row, action.from.col, action.to.row, action.to.col, action.landingMode);
    }
    return result && result.ok ? next : null;
  }

  function orderActions(state, actions, ttMove) {
    const preferred = actionKey(ttMove);
    return actions.map(action => {
      let score = actionKey(action) === preferred ? 100000000 : 0;
      if (action.type === "deploy") {
        const piece = state.hands[state.turn].find(p => p.id === action.pieceId);
        if (piece) score += deploymentPriority(state, state.turn, piece, action.row, action.col) * 3;
      } else {
        const target = state.board[action.to.row][action.to.col];
        const attacker = state.board[action.from.row][action.from.col].slice(-1)[0];
        if (target.length && target[target.length - 1].side !== state.turn) {
          const victim = target[target.length - 1];
          score += (PIECE_VALUES[victim.name] || 0) * 12 - (PIECE_VALUES[attacker.name] || 0);
          if (action.landingMode === "tsuke") score += 35;
        }
        if (attacker && attacker.name === "帥") score += 15;
      }
      return { action, score };
    }).sort((a,b) => b.score - a.score).map(item => item.action);
  }

  // 静止探索用：通常探索の末端でも、実際に駒を取る手だけを追加で読む。
  // 「取り合いの途中」で評価を止める水平線効果を軽減する。
  function generateCaptureActions(state, side) {
    const actions = [];
    for (const move of E.generateLegalMoves(state, side)) {
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
        const deadline = started + timeMs;
        const table = new Map();
        const stats = { nodes: 0, qnodes: 0, cutoffs: 0, ttHits: 0 };
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
          if ((stats.nodes & 127) === 0) checkStop();
          if (position.phase === "finished") {
            return position.winner === position.turn ? MATE - ply : -MATE + ply;
          }

          const standPat = AI.evaluate(position, position.turn);
          if (qply >= 5) return standPat;
          if (standPat >= beta) return standPat;
          if (standPat > alpha) alpha = standPat;

          const captures = generateCaptureActions(position, position.turn);
          const ordered = orderActions(position, captures, null);
          for (const action of ordered) {
            checkStop();
            const child = applyAction(position, action);
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
          if (depth <= 0) return quiescence(position, alpha, beta, ply, 0);

          const key = positionKey(position);
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
          const actions = orderActions(position, generateActions(position, position.turn, maxDeployCandidates), cached && cached.best);
          if (!actions.length) return AI.evaluate(position, position.turn);
          let bestScore = -INF;
          let bestAction = null;
          for (const action of actions) {
            checkStop();
            const child = applyAction(position, action);
            if (!child) continue;
            const score = -negamax(child, depth - 1, -beta, -alpha, ply + 1);
            if (score > bestScore) {
              bestScore = score;
              bestAction = action;
            }
            if (score > alpha) alpha = score;
            if (alpha >= beta) {
              stats.cutoffs += 1;
              break;
            }
          }
          if (!bestAction) return AI.evaluate(position, position.turn);
          const flag = bestScore <= originalAlpha ? "upper" : bestScore >= originalBeta ? "lower" : "exact";
          store(key, { depth, score: bestScore, flag, best: bestAction });
          return bestScore;
        }

        function searchRoot(root, depth, previousBest) {
          const key = positionKey(root);
          const cached = table.get(key);
          const actions = orderActions(root, generateActions(root, root.turn, maxDeployCandidates), previousBest || (cached && cached.best));
          let alpha = -INF;
          const beta = INF;
          let bestScore = -INF;
          let bestAction = null;
          for (const action of actions) {
            checkStop();
            const child = applyAction(root, action);
            if (!child) continue;
            const score = -negamax(child, depth - 1, -beta, -alpha, 1);
            if (score > bestScore) {
              bestScore = score;
              bestAction = action;
            }
            if (score > alpha) alpha = score;
          }
          if (bestAction) store(key, { depth, score: bestScore, flag: "exact", best: bestAction });
          return { bestAction, score: bestScore };
        }

        let completed = null;
        let previousBest = null;
        const fallback = generateActions(state, state.turn, maxDeployCandidates)[0] || null;
        if (!fallback) { resolve({ bestMove: null, score: AI.evaluate(state, state.turn), depth: 0, nodes: 0, elapsedMs: now() - started }); return; }
        for (let depth = 1; depth <= maxDepth; depth += 1) {
          try {
            checkStop();
            const result = searchRoot(state, depth, previousBest);
            if (result.bestAction) {
              completed = { ...result, depth };
              previousBest = result.bestAction;
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
        const result = completed || { bestAction: fallback, score: AI.evaluate(state, state.turn), depth: 0 };
        resolve({
          bestMove: result.bestAction,
          score: result.score,
          depth: result.depth,
          nodes: stats.nodes,
          quiescenceNodes: stats.qnodes,
          cutoffs: stats.cutoffs,
          transpositionHits: stats.ttHits,
          elapsedMs: Math.round(now() - started)
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
    for (const piece of pieces) {
      for (let row = 0; row < E.SIZE; row += 1) {
        for (let col = 0; col < E.SIZE; col += 1) {
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
    if (!state || state.phase !== "setup") {
      throw new TypeError("初期配置中の局面を指定してください。");
    }
    const side = state.setupTurn;
    const candidates = generateSetupActions(state);
    const started = now();
    const timeMs = Math.max(100, Math.min(5000, Number(options.timeMs) || 1400));
    const deadline = started + timeMs;
    const maxNodes = Math.max(20, Math.min(2000, Number(options.maxNodes) || 1200));
    let nodes = 0;
    let best = null;
    let bestScore = -INF;
    for (const action of candidates) {
      const piece = (state.hands[side] || []).find(p => p.id === action.pieceId);
      if (!piece) continue;
      const next = cloneState(state);
      const placed = E.placePiece(next, action.row, action.col, side, action.pieceId);
      if (!placed.ok) continue;
      nodes += 1;
      const stackBonus = action.stacking ? 1.5 * action.targetLayer : 0;
      const score = AI.evaluate(next, side) +
        deploymentPriority(state, side, piece, action.row, action.col) * 0.08 +
        stackBonus;
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
      if (nodes % 24 === 0) {
        if (typeof options.onProgress === "function") {
          options.onProgress({ nodes, score: bestScore, elapsedMs: Math.round(now() - started) });
        }
        await new Promise(done => setTimeout(done, 0));
        if (now() >= deadline || nodes >= maxNodes) break;
      }
      if (now() >= deadline || nodes >= maxNodes) break;
    }
    return {
      bestMove: best, score: bestScore, depth: 1, nodes,
      candidateCount: candidates.length,
      stackingCandidates: candidates.filter(action => action.stacking).length,
      elapsedMs: Math.round(now() - started)
    };
  }

  window.GungiSearch = Object.freeze({
    findBestMove,
    findBestSetupPlacement,
    generateSetupActions,
    generateActions: (state, options = {}) => generateActions(state, state.turn, options.maxDeployCandidates || 12),
    cloneState
  });
})();
