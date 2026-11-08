import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "engine-20261107bb.js": "engine-20261107bb.js",
  "evaluation-20261107be.js": "evaluation-20261107be.js",
  "search-20261108cycle2.js": "search-20261108cycle2.js",
  "training-worker-20261107a.js": "training-worker-20261107a.js"
};
const self = {};
const context = vm.createContext({
  self, window: self, console, Date, Math, Map, Set, Object, Array, Number,
  String, Boolean, JSON, Promise, Error, TypeError, performance, setTimeout, clearTimeout
});
context.importScripts = (...urls) => {
  for (const url of urls) {
    const name = path.basename(String(url).split("?")[0]);
    const file = files[name];
    if (!file) throw new Error("Unexpected worker import: " + url);
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
};
self.importScripts = context.importScripts;
vm.runInContext(fs.readFileSync(path.join(root, files["training-worker-20261107a.js"]), "utf8"), context, {
  filename: "training-worker-20261107a.js"
});

const FEATURES = ["material","hand","position","activity","mobility","threats","exposure","kingSafety","mateNet"];
const BASELINE = Object.fromEntries(FEATURES.map(key => [key, 1]));
const stateDir = process.env.TRAINING_STATE_DIR || path.join(root, ".training-state");
const checkpointPath = path.join(stateDir, "checkpoint.json");
const outputDir = path.join(root, "artifacts");
const gamesRequested = Math.max(1, Math.min(100, Number(process.env.GAME_COUNT) || 10));
const maxPlies = Math.max(20, Math.min(108, Number(process.env.MAX_PLIES) || 108));
const checkpointEvery = Math.max(1, Math.min(10, Number(process.env.CHECKPOINT_EVERY) || 1));

function normalizeWeights(input) {
  const weights = {};
  for (const key of FEATURES) {
    const value = Number(input && input[key]);
    if (!Number.isFinite(value) || value < 0.25 || value > 2.5) {
      throw new Error("Invalid checkpoint weight: " + key);
    }
    weights[key] = value;
  }
  return weights;
}
function readCheckpoint() {
  try {
    const saved = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (saved.format !== "gungi-server-training-checkpoint" || saved.version !== 1) return null;
    return {
      format: saved.format, version: 1,
      games: Math.max(0, Number(saved.games) || 0),
      weights: normalizeWeights(saved.weights),
      totals: saved.totals && typeof saved.totals === "object" ? saved.totals : {},
      updatedAt: saved.updatedAt || null
    };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Checkpoint could not be loaded; starting from baseline:", error.message);
    return null;
  }
}
function valueOf(features, weights) {
  const raw = FEATURES.reduce((sum, key) => sum + weights[key] * (features[key] || 0), 0) / 1800;
  return Math.tanh(Math.max(-8, Math.min(8, raw)));
}
function trainTrajectory(trajectory, finalTarget, initial) {
  const weights = { ...initial };
  const trace = Object.fromEntries(FEATURES.map(key => [key, 0]));
  const updateDiagnostics = Object.fromEntries(FEATURES.map(key => [key, { tdDelta: 0, regularization: 0, net: 0, absolute: 0 }]));
  const alpha = 0.0025, gamma = 0.985, lambda = 0.72, regularization = 0.06;
  let absoluteError = 0, updates = 0;
  for (let i = 0; i < trajectory.length; i++) {
    const current = trajectory[i];
    const currentValue = valueOf(current, weights);
    const terminal = i === trajectory.length - 1;
    const nextValue = terminal ? finalTarget : valueOf(trajectory[i + 1], weights);
    const delta = (terminal ? finalTarget : gamma * nextValue) - currentValue;
    for (const key of FEATURES) {
      trace[key] = gamma * lambda * trace[key] + (current[key] || 0) / 1800;
      const gradient = 1 - currentValue * currentValue;
      const tdUpdate = delta * gradient * trace[key];
      const regularizationUpdate = -regularization * (weights[key] - 1);
      const update = tdUpdate + regularizationUpdate;
      updateDiagnostics[key].tdDelta += alpha * tdUpdate;
      updateDiagnostics[key].regularization += alpha * regularizationUpdate;
      updateDiagnostics[key].net += alpha * update;
      updateDiagnostics[key].absolute += Math.abs(alpha * update);
      weights[key] = Math.max(0.25, Math.min(2.5, weights[key] + alpha * update));
    }
    absoluteError += Math.abs(delta);
    updates++;
  }
  return { weights, meanTdError: updates ? absoluteError / updates : 0, updates, updateDiagnostics };
}
function trainMateSamples(samples, initial) {
  const weights = { ...initial };
  let updates = 0;
  for (const sample of samples || []) {
    const x = ((sample.features && sample.features.mateNet) || 0) / 600;
    if (!x) continue;
    const prediction = Math.tanh(weights.mateNet * x);
    const delta = sample.target - prediction;
    weights.mateNet = Math.max(0.25, Math.min(2.5,
      weights.mateNet + 0.06 * delta * (1 - prediction * prediction) * x));
    updates++;
  }
  return { weights, updates };
}
function saveCheckpoint(checkpoint) {
  fs.mkdirSync(stateDir, { recursive: true });
  const temporary = checkpointPath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify({
    format: "gungi-server-training-checkpoint", version: 1,
    games: checkpoint.games, weights: checkpoint.weights, totals: checkpoint.totals,
    updatedAt: new Date().toISOString()
  }, null, 2));
  fs.renameSync(temporary, checkpointPath);
}
function playGame(id, candidateWeights, championWeights, candidateSide, seed) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Self-play game timed out after 30 minutes.")), 30 * 60 * 1000);
    self.postMessage = message => {
      clearTimeout(timeout);
      if (message && message.ok) resolve(message.result);
      else reject(new Error(message && message.error || "Training worker returned no result."));
    };
    self.onmessage({ data: { id, candidateWeights, championWeights, candidateSide, maxPlies, seed } });
  });
}

const previous = readCheckpoint();
let checkpoint = previous || {
  format: "gungi-server-training-checkpoint", version: 1, games: 0,
  weights: { ...BASELINE },
  totals: { candidateWins: 0, championWins: 0, draws: 0, nodes: 0, plies: 0, tdUpdates: 0, mateUpdates: 0, tdErrorSum: 0, tdErrorGames: 0 }
};
const championWeights = { ...BASELINE };
const runResults = [];
const runStartedAt = new Date().toISOString();
console.log(JSON.stringify({
  event: "training-start", resumed: !!previous, startingGames: checkpoint.games,
  gamesRequested, maxPlies, startingWeights: checkpoint.weights
}));
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

for (let index = 0; index < gamesRequested; index++) {
  const candidateSide = (checkpoint.games % 2 === 0) ? "先手" : "後手";
  const beforeWeights = { ...checkpoint.weights };
  const gameNumber = checkpoint.games + 1;
  const result = await playGame("server-training-" + gameNumber, beforeWeights, championWeights, candidateSide, gameNumber * 7919 + 104729);
  let learned = { weights: beforeWeights, updates: 0, meanTdError: 0 };
  if (result.trajectory && result.trajectory.length) {
    learned = trainTrajectory(result.trajectory, result.finalTarget, beforeWeights);
  }
  const mate = trainMateSamples(result.mateSamples, learned.weights);
  checkpoint.weights = mate.weights;
  checkpoint.games++;
  const totals = checkpoint.totals;
  totals.candidateWins = (totals.candidateWins || 0) + (result.winner === candidateSide ? 1 : 0);
  totals.championWins = (totals.championWins || 0) + (result.winner && result.winner !== candidateSide ? 1 : 0);
  totals.drawEvaluationSum = (totals.drawEvaluationSum || 0) + (result.draw ? (result.candidateFinalScore || 0) : 0);
  totals.drawEvaluationCount = (totals.drawEvaluationCount || 0) + (result.draw ? 1 : 0);
  totals.draws = (totals.draws || 0) + (result.draw ? 1 : 0);
  totals.nodes = (totals.nodes || 0) + (result.nodes || 0);
  totals.plies = (totals.plies || 0) + (result.plies || 0);
  totals.tdUpdates = (totals.tdUpdates || 0) + (learned.updates || 0);
  totals.mateUpdates = (totals.mateUpdates || 0) + (mate.updates || 0);
  totals.tdErrorSum = (totals.tdErrorSum || 0) + (learned.meanTdError || 0);
  totals.tdErrorGames = (totals.tdErrorGames || 0) + (learned.updates ? 1 : 0);
  const gameSummary = {
    game: checkpoint.games, candidateSide, winner: result.winner || null, draw: !!result.draw,
    startKey: result.startKey, endReason: result.endReason || (result.winner ? "marshal-captured" : "max-plies"),
    marshalCount: ["先手","後手"].reduce((counts, side) => {
      counts[side] = result.finalState.board.flat().flat().filter(piece => piece.side === side && piece.name === "帥").length;
      return counts;
    }, {}),
    lastMoves: (result.history || []).slice(-8),
    fullHistory: result.history || [],
    repetitionEvents: result.repetitionEvents || [],
    tdUpdateDiagnostics: learned.updateDiagnostics || {},
    weightsBefore: beforeWeights,
    weightsAfterTd: learned.weights,
    weightsAfterMate: mate.weights,
    plies: result.plies, nodes: result.nodes, captures: result.captures || 0,
    deployments: result.deployments || 0, uniquePositions: result.uniquePositions || 0,
    repeatedPositionVisits: result.repeatedPositionVisits || 0,
    threefoldPositionCount: result.threefoldPositionCount || 0,
    maxPositionVisits: result.maxPositionVisits || 1, finalTarget: result.finalTarget,
    candidateFinalScore: result.candidateFinalScore, trajectorySamples: result.trajectory.length,
    mateSamples: (result.mateSamples || []).length, tdUpdates: learned.updates, mateUpdates: mate.updates,
    finalState: result.finalState
  };
  runResults.push(gameSummary);
  if (checkpoint.games % checkpointEvery === 0 || index === gamesRequested - 1) {
    saveCheckpoint(checkpoint);
  }
  console.log(JSON.stringify({ event: "game-complete", ...gameSummary, totalGames: checkpoint.games }));
}

const summary = {
  success: true, mode: "multi-game-server-self-play-training",
  runStartedAt, completedAt: new Date().toISOString(),
  resumed: !!previous, gamesThisRun: runResults.length, totalGames: checkpoint.games,
  maxPlies, results: runResults, uniqueStartPositions: new Set(runResults.map(x => x.startKey)).size,
  uniqueFinalPositions: new Set(runResults.map(x => JSON.stringify(x.finalState.board))).size,
  progress: {
    capturesThisRun: runResults.reduce((sum, x) => sum + x.captures, 0),
    deploymentsThisRun: runResults.reduce((sum, x) => sum + x.deployments, 0),
    uniquePositionsThisRun: runResults.reduce((sum, x) => sum + x.uniquePositions, 0),
    repeatedPositionVisitsThisRun: runResults.reduce((sum, x) => sum + x.repeatedPositionVisits, 0),
    threefoldPositionCountThisRun: runResults.reduce((sum, x) => sum + (x.threefoldPositionCount || 0), 0),
    maxPositionVisitsThisRun: Math.max(1, ...runResults.map(x => x.maxPositionVisits || 1)),
    repetitionEventCountThisRun: runResults.reduce((sum, x) => sum + (x.repetitionEvents || []).length, 0),
    medianCycleLengthThisRun: (() => { const a=runResults.flatMap(x=>(x.repetitionEvents||[]).map(e=>e.cycleLength)).sort((x,y)=>x-y); return a.length?a[Math.floor(a.length/2)]:0; })()
  },
  weightDiagnostics: {
    min: Math.min(...Object.values(checkpoint.weights)),
    max: Math.max(...Object.values(checkpoint.weights)),
    mean: Object.values(checkpoint.weights).reduce((sum, value) => sum + value, 0) / Object.keys(checkpoint.weights).length,
    distanceFromBaselineL1: Object.values(checkpoint.weights).reduce((sum, value) => sum + Math.abs(value - 1), 0)
  },
  drawMeanCandidateFinalScore: checkpoint.totals.drawEvaluationCount
    ? checkpoint.totals.drawEvaluationSum / checkpoint.totals.drawEvaluationCount : 0,
  totals: checkpoint.totals, weights: checkpoint.weights,
  meanTdError: checkpoint.totals.tdErrorGames
    ? checkpoint.totals.tdErrorSum / checkpoint.totals.tdErrorGames : 0
};
fs.writeFileSync(path.join(outputDir, "server-training-report.json"), JSON.stringify(summary, null, 2));
saveCheckpoint(checkpoint);
fs.copyFileSync(checkpointPath, path.join(outputDir, "server-training-checkpoint.json"));
console.log(JSON.stringify({ event: "training-complete", ...summary }, null, 2));
