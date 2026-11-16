import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
fs.writeFileSync(path.join(outDir, "final-summary.json"), JSON.stringify({
  success: true,
  mode: "no-paid-model-api",
  cyclesCompleted: log.length,
  latestMetrics: latest?.metrics || null,
  note: "Engine source code was not rewritten. The existing TD(lambda) and mate-sample learner updated checkpoint evaluation weights between self-play cycles."
}, null, 2));
writeLog();
console.log(JSON.stringify({
  event: "free-autonomous-training-complete",
  cyclesCompleted: log.length,
  latestMetrics: latest?.metrics || null
}, null, 2));
