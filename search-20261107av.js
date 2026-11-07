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
    const deployments = [];
    for (const piece of reserve) {
      if (seenNames.has(piece.name)) continue;
      seenNames.add(piece.name);
      for (let row = 0; row < E.SIZE; row += 1) {
        for (let col = 0; col < E.SIZE; col += 1) {
          if (!E.canDeployPiece(state, row, col, side, piece)) continue;
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
        const stats = { nodes: 0, cutoffs: 0, ttHits: 0 };
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

        function negamax(position, depth, alpha, beta, ply) {
          stats.nodes += 1;
          if ((stats.nodes & 127) === 0) checkStop();
          if (position.phase === "finished") {
            return position.winner === position.turn ? MATE - ply : -MATE + ply;
          }
          if (depth <= 0) return AI.evaluate(position, position.turn);

          const key = positionKey(position);
          const originalAlpha = alpha;
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
          const flag = bestScore <= originalAlpha ? "upper" : bestScore >= beta ? "lower" : "exact";
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
        if (!fallback) return { bestMove: null, score: AI.evaluate(state, state.turn), depth: 0, nodes: 0, elapsedMs: now() - started };
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
          cutoffs: stats.cutoffs,
          transpositionHits: stats.ttHits,
          elapsedMs: Math.round(now() - started)
        });
      })().catch(reject);
    });
  }

  window.GungiSearch = Object.freeze({
    findBestMove,
    generateActions: (state, options = {}) => generateActions(state, state.turn, options.maxDeployCandidates || 12),
    cloneState
  });
})();
