import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "engine-20261107bb.js": "engine-20261107bb.js",
  "evaluation-20261107be.js": "evaluation-20261107be.js",
  "search-20261107bd.js": "search-20261107bd.js",
  "training-worker-20261107a.js": "training-worker-20261107a.js"
};
const self = {};
const context = vm.createContext({
  self,
  window: self,
  console,
  Date,
  Math,
  Map,
  Set,
  Object,
  Array,
  Number,
  String,
  Boolean,
  JSON,
  Promise,
  Error,
  TypeError,
  performance,
  setTimeout,
  clearTimeout
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

const maxPlies = Math.max(1, Math.min(108, Number(process.env.MAX_PLIES) || 108));
const weights = { material:1, hand:1, position:1, activity:1, mobility:1, threats:1, exposure:1, kingSafety:1, mateNet:1 };
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Self-play smoke test timed out after 30 minutes.")), 30 * 60 * 1000);
  self.postMessage = message => {
    clearTimeout(timeout);
    if (message && message.ok) resolve(message.result);
    else reject(new Error(message && message.error || "Worker returned no result."));
  };
  self.onmessage({ data: {
    id: "server-smoke-1",
    candidateWeights: weights,
    championWeights: weights,
    candidateSide: "先手",
    maxPlies
  }});
});

const summary = {
  success: true,
  mode: "single-game-server-smoke-test",
  completedAt: new Date().toISOString(),
  plies: result.plies,
  nodes: result.nodes,
  winner: result.winner,
  draw: result.draw,
  finalPhase: result.finalState.phase,
  candidateFinalScore: result.candidateFinalScore,
  trajectorySamples: result.trajectory.length,
  historyEntries: result.history.length,
  finalState: result.finalState
};
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "server-training-smoke.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, finalState: undefined }, null, 2));
