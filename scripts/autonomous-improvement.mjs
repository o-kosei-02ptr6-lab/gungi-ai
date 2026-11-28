import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const root = process.cwd();
const cycles = Math.max(1, Math.min(2, Number(process.env.AUTO_CYCLES) || 2));
const games = Math.max(1, Math.min(20, Number(process.env.GAME_COUNT) || 10));
const maxPlies = Math.max(20, Math.min(108, Number(process.env.MAX_PLIES) || 108));
const outDir = path.join(root, "artifacts", "autonomous");
fs.mkdirSync(outDir, { recursive: true });
const log = [];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}
function regression() {
  run("node", ["scripts/search-context-regression.mjs"]);
  run("node", ["scripts/movegen-regression.mjs"]);
}
function readReport() {
  return JSON.parse(fs.readFileSync(path.join(root, "artifacts", "server-training-report.json"), "utf8"));
}
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
function summarize(report) {
  const results = report.results || [];
  const wins = results.filter(game => game.winner && game.winner === game.candidateSide).length;
  const losses = results.filter(game => game.winner && game.winner !== game.candidateSide).length;
  const draws = results.filter(game => game.draw).length;
  const diagnostics = report.progress?.searchDiagnostics || {};
  return {
    gamesThisRun: report.gamesThisRun,
    totalGames: report.totalGames,
    candidateWins: wins,
    championWins: losses,
    draws,
    candidateScoreRate: results.length ? Number(((wins + draws * 0.5) / results.length).toFixed(3)) : 0,
    meanCompletedDepth: diagnostics.meanCompletedDepth || 0,
    meanElapsedMs: diagnostics.meanElapsedMs || 0,
    meanNodes: diagnostics.meanNodes || 0,
    repeatedPositionVisits: report.progress?.repeatedPositionVisitsThisRun || 0,
    threefoldPositionCount: report.progress?.threefoldPositionCountThisRun || 0,
    medianCycleLength: report.progress?.medianCycleLengthThisRun || 0,
    tdUpdates: report.totals?.tdUpdates || 0,
    mateUpdates: report.totals?.mateUpdates || 0,
    meanTdError: report.meanTdError || 0,
    weights: report.weights || {}
  };
}
function weightDelta(before, after) {
  const keys = Object.keys(after || {});
  return Object.fromEntries(keys.map(key => [key, Number(((Number(after[key]) || 0) - (Number(before?.[key]) || 0)).toFixed(6))]));
}
function writeLog() {
  fs.writeFileSync(path.join(outDir, "cycle-log.json"), JSON.stringify(log, null, 2));
}

async function runPairedValidation(candidateWeights, candidatePolicyWeightsBySide, pairs = 2) {
  const files = {
    "engine-20261107bb.js": "engine-20261107bb.js",
    "evaluation-20261107be.js": "evaluation-20261107be.js",
    "search-20261108cycle3.js": "search-20261108cycle3.js",
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
      if (!files[name]) throw new Error("Unexpected worker import: " + url);
      vm.runInContext(fs.readFileSync(path.join(root, files[name]), "utf8"), context, { filename: files[name] });
    }
  };
  self.importScripts = context.importScripts;
  vm.runInContext(fs.readFileSync(path.join(root, files["training-worker-20261107a.js"]), "utf8"), context);
  const baseline = Object.fromEntries(["material","hand","position","activity","mobility","threats","exposure","kingSafety","mateNet"].map(key => [key, 1]));
  const searchOptions = { maxDepth: 8, timeMs: 5200, maxNodes: 60000, maxDeployCandidates: 12, maxTTEntries: 60000 };
  const play = (id, candidateSide, seed) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Paired validation timed out.")), 30 * 60 * 1000);
    self.postMessage = message => {
      clearTimeout(timeout);
      if (message && message.ok) resolve(message.result);
      else reject(new Error(message && message.error || "Validation worker returned no result."));
    };
    self.onmessage({ data: {
      id, candidateWeights, championWeights: baseline,
      candidatePolicyWeights: candidatePolicyWeightsBySide || { "先手": {}, "後手": {} },
      championPolicyWeights: {}, candidateSide, maxPlies, searchOptions, seed
    }});
  });
  const results = [];
  for (let pair = 0; pair < pairs; pair++) {
    const seed = 900001 + pair * 104729;
    for (const candidateSide of ["先手", "後手"]) {
      const result = await play("paired-validation-" + pair + "-" + candidateSide, candidateSide, seed);
      results.push({
        pair, seed, candidateSide, winner: result.winner || null, draw: !!result.draw,
        score: result.winner === candidateSide ? 1 : result.winner ? 0 : 0.5,
        plies: result.plies, nodes: result.nodes, startKey: result.startKey
      });
    }
  }
  const bySide = Object.fromEntries(["先手","後手"].map(side => {
    const subset = results.filter(item => item.candidateSide === side);
    return [side, { games: subset.length, wins: subset.filter(x=>x.score===1).length,
      losses: subset.filter(x=>x.score===0).length, draws: subset.filter(x=>x.score===0.5).length,
      scoreRate: subset.length ? Number((subset.reduce((sum,x)=>sum+x.score,0)/subset.length).toFixed(3)) : 0 }];
  }));
  return {
    games: results.length, pairs, results, bySide,
    scoreRate: Number((results.reduce((sum,x)=>sum+x.score,0)/results.length).toFixed(3)),
    matchedStartPositions: results.every((item,index)=>index%2===0 || item.startKey===results[index-1].startKey)
  };
}

console.log(JSON.stringify({
  event: "free-autonomous-training-start",
  mode: "deterministic-self-play-and-TD-weight-learning",
  cycles,
  gamesPerCycle: games,
  maxPlies
}));
regression();

let previousWeights = null;
for (let cycle = 1; cycle <= cycles; cycle++) {
  console.log(JSON.stringify({ event: "cycle-start", cycle, cycles, games }));
  run("node", ["scripts/server-training.mjs"], {
    // The trainer emits one JSON line per move; discard stdout here to avoid
    // execFileSync's small default maxBuffer being exhausted on long runs.
    // Keep stderr captured so genuine failures remain visible in the job log.
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GAME_COUNT: String(games),
      MAX_PLIES: String(maxPlies),
      CHECKPOINT_EVERY: "1",
      SEARCH_PROFILE: "deep",
      TRAINING_STATE_DIR: ".training-state"
    }
  });
  const report = readReport();
  const metrics = summarize(report);
  const initialWeights = previousWeights || report.results?.[0]?.weightsBefore || {};
  const delta = weightDelta(initialWeights, metrics.weights);
  const entry = {
    cycle,
    status: "completed",
    metrics,
    weightDeltaFromPreviousCycle: delta,
    learningUpdatedWeights: Object.values(delta).some(value => value !== 0)
  };
  log.push(entry);
  fs.writeFileSync(path.join(outDir, "cycle-" + cycle + "-training-report.json"), JSON.stringify(report, null, 2));
  writeLog();
  console.log(JSON.stringify({ event: "cycle-analysis", ...entry }));

  if (!report.success || !report.gamesThisRun) {
    entry.status = "stopped-no-valid-training-result";
    writeLog();
    throw new Error("Training report did not confirm a successful non-empty training run.");
  }
  regression();
  previousWeights = metrics.weights;
  if (cycle < cycles && !entry.learningUpdatedWeights) {
    entry.status = "stopped-no-weight-change";
    writeLog();
    console.log(JSON.stringify({ event: "cycle-stop", reason: "no-learned-weight-change", cycle }));
    break;
  }
}
const latest = log[log.length - 1];
const finalReport = readReport();
const pairedValidation = await runPairedValidation(
  latest?.metrics?.weights || finalReport.weights || {},
  finalReport.policyWeightsBySide || { "先手": {}, "後手": {} }, 2
);
fs.writeFileSync(path.join(outDir, "paired-validation.json"), JSON.stringify(pairedValidation, null, 2));
fs.writeFileSync(path.join(outDir, "final-summary.json"), JSON.stringify({
  success: true,
  mode: "no-paid-model-api",
  cyclesCompleted: log.length,
  latestMetrics: latest?.metrics || null,
  pairedValidation,
  promotionDecision: "not-automatic; retain champion until a larger statistically meaningful paired test confirms improvement",
  note: "Engine source code was not rewritten. TD(lambda), mate-sample and side-specific policy learning were followed by matched-start validation against the unchanged baseline champion."
}, null, 2));
writeLog();
console.log(JSON.stringify({
  event: "free-autonomous-training-complete",
  cyclesCompleted: log.length,
  latestMetrics: latest?.metrics || null
}, null, 2));
