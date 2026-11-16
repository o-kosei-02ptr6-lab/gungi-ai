import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-6.1-sol";
const cycles = Math.max(1, Math.min(2, Number(process.env.AUTO_CYCLES) || 2));
const games = Math.max(1, Math.min(20, Number(process.env.GAME_COUNT) || 10));
const maxPlies = Math.max(20, Math.min(108, Number(process.env.MAX_PLIES) || 108));
const allowed = new Set([
  "engine-20261107bb.js",
  "search-20261108cycle3.js",
  "evaluation-20261107be.js"
]);
const outDir = path.join(root, "artifacts", "autonomous");
fs.mkdirSync(outDir, { recursive: true });
const log = [];
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
}
function git(...args) { return run("git", args); }
function regression() {
  run("node", ["scripts/search-context-regression.mjs"]);
  run("node", ["scripts/movegen-regression.mjs"]);
}
function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  return (response.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === "output_text" && typeof item.text === "string")
    .map(item => item.text).join("\n");
}
function extractPatch(text) {
  const fenced = text.match(/```diff\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}
async function askForPatch(report, target, source) {
  const prompt = [
    "あなたは軍儀AIエンジンの保守担当です。",
    "直近の自己対局レポートと対象ファイルだけを根拠に、探索効率または評価品質を改善する最小の修正を提案してください。",
    "出力は unified diff のみ。説明文、Markdown囲み、複数ファイル変更は禁止。変更不要なら NO_CHANGE とだけ返してください。",
    "対象ファイルは " + target + " のみ。ルール、合法手、帥手/詰み判定、既存API、ファイル名/読み込み順を変更しないこと。",
    "測定されていない改善を断言しない。推測的な大規模変更、探索上限の引き下げ、局面の手抜き評価、ランダム性導入は禁止。",
    "回帰テストが通ることを前提に、キャッシュ整合性・探索の正確性・時間制限の安全性を優先する。",
    "学習レポート（JSON）:\n" + JSON.stringify({
      gamesThisRun: report.gamesThisRun,
      totalGames: report.totalGames,
      maxPlies: report.maxPlies,
      searchOptions: report.searchOptions,
      progress: report.progress,
      weightDiagnostics: report.weightDiagnostics,
      results: (report.results || []).map(g => ({
        winner: g.winner, draw: g.draw, plies: g.plies,
        searchDepth: g.searchDepth, nodes: g.nodes,
        repeatedPositionVisits: g.repeatedPositionVisits,
        threefoldPositionCount: g.threefoldPositionCount
      }))
    }),
    "対象ソースコード:\n" + source
  ].join("\n\n");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 6000,
      store: false
    }),
    signal: AbortSignal.timeout(180000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error("OpenAI API request failed (" + response.status + "): " + JSON.stringify(body).slice(0, 1500));
  const text = outputText(body).trim();
  if (!text) throw new Error("Model returned an empty patch response.");
  return extractPatch(text);
}

if (!apiKey) {
  console.error("OPENAI_API_KEY is not configured. Add it as a repository Actions secret to enable autonomous code analysis and fixes.");
  process.exit(2);
}
if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is missing; the workflow must grant contents: write.");
  process.exit(2);
}
regression();
for (let cycle = 1; cycle <= cycles; cycle++) {
  console.log(JSON.stringify({ event: "cycle-start", cycle, cycles, games, model }));
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
  const reportPath = path.join(root, "artifacts", "server-training-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const telemetry = report.progress?.searchDiagnostics || {};
  const target = (Number(telemetry.meanCompletedDepth) < 2.5 || Number(telemetry.meanElapsedMs) >= 4500)
    ? "search-20261108cycle3.js"
    : "evaluation-20261107be.js";
  if (!allowed.has(target)) throw new Error("Internal target allowlist violation.");
  const source = fs.readFileSync(path.join(root, target), "utf8");
  const patch = await askForPatch(report, target, source);
  if (patch === "NO_CHANGE" || patch.replace(/\s/g, "") === "NO_CHANGE") {
    log.push({ cycle, status: "no-change", target, meanDepth: telemetry.meanCompletedDepth || 0 });
    console.log(JSON.stringify({ event: "cycle-stop", reason: "model-proposed-no-change", cycle, target }));
    break;
  }
  if (!patch.startsWith("diff --git ") || !patch.includes("+++ b/" + target)) {
    throw new Error("Model output is not a unified diff for the permitted target file.");
  }
  const changedPaths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  if (changedPaths.length !== 1 || changedPaths[0] !== target) {
    throw new Error("Patch attempted to modify a file outside the single-file allowlist.");
  }
  try {
    run("git", ["apply", "--check", "--"], { input: patch });
    run("git", ["apply", "--"], { input: patch });
    git("diff", "--check");
    const actualPaths = git("diff", "--name-only").trim().split("\n").filter(Boolean);
    if (actualPaths.length !== 1 || actualPaths[0] !== target) throw new Error("Unexpected modified file set: " + actualPaths.join(","));
    regression();
  } catch (error) {
    run("git", ["checkout", "--", target]);
    log.push({ cycle, status: "rejected", target, reason: String(error.message || error).slice(0, 1000) });
    fs.writeFileSync(path.join(outDir, "cycle-log.json"), JSON.stringify(log, null, 2));
    throw new Error("Candidate patch was rejected; original source restored. " + (error.message || error));
  }
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("add", "--", target);
  git("commit", "-m", "Apply tested autonomous engine improvement");
  const branch = process.env.GITHUB_REF_NAME || "main";
  git("push", "origin", "HEAD:" + branch);
  const commit = git("rev-parse", "HEAD").trim();
  log.push({
    cycle, status: "accepted-and-pushed", target, commit,
    meanDepthBefore: telemetry.meanCompletedDepth || 0,
    meanElapsedMsBefore: telemetry.meanElapsedMs || 0,
    gamesThisRun: report.gamesThisRun
  });
  fs.writeFileSync(path.join(outDir, "cycle-" + cycle + "-training-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "cycle-log.json"), JSON.stringify(log, null, 2));
  console.log(JSON.stringify({ event: "patch-accepted", cycle, target, commit }));
}
fs.writeFileSync(path.join(outDir, "cycle-log.json"), JSON.stringify(log, null, 2));
console.log(JSON.stringify({ event: "autonomous-improvement-complete", cyclesRequested: cycles, cyclesCompleted: log.length, log }, null, 2));
