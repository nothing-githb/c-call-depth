#!/usr/bin/env node
// One-command test runner for the C Call Depth test suite.
//
//   node run-all.js
//
// It (1) points the bundled workspace's compile_commands.json at its real
// location, (2) generates the analysis JSON files the Python/template tests
// need (using the bundled cdepth_cli, if Python + libclang are available),
// then (3) runs every test and prints each suite's "ok" / "FAIL" lines.
//
// Requirements:
//   - Node.js (for the .js suites). jsdom is resolved from ./node_modules if
//     present, else from NODE_PATH, else the runner offers to `npm i jsdom`.
//   - Python 3 + libclang (only for the .py and template suites). If missing,
//     those suites are skipped with a clear note; the JS UI suites still run.

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const TEST = path.join(ROOT, "test");
const WS = path.join(ROOT, "workspace");
const BUILD = path.join(WS, "build");
const CC = path.join(WS, "compile_commands.json");
const TMP = path.join(ROOT, ".analysis");
const ALLF = path.join(TMP, "allf.json");        // no root pattern
const ALLFP = path.join(TMP, "allfp.json");      // --root-pattern **/public/**

function log(s) { process.stdout.write(s + "\n"); }
function hr() { log("─".repeat(64)); }

// ── 1. Point compile_commands.json at the real workspace path ──────────────
function fixCompileCommands() {
  if (!fs.existsSync(CC)) return;
  let txt = fs.readFileSync(CC, "utf8");
  txt = txt.replace(/"directory":\s*"[^"]*"/g, `"directory": "${WS}"`);
  fs.writeFileSync(CC, txt);
}

// ── 2. Locate jsdom so the webview suites can run ──────────────────────────
function resolveNodePath() {
  // Prefer a bundled ./node_modules; else an existing NODE_PATH; else null.
  const local = path.join(ROOT, "node_modules");
  if (fs.existsSync(path.join(local, "jsdom"))) return local;
  if (process.env.NODE_PATH && fs.existsSync(path.join(process.env.NODE_PATH, "jsdom")))
    return process.env.NODE_PATH;
  // try a global resolve
  try { require.resolve("jsdom"); return ""; } catch (_) {}
  return null;
}

function ensureJsdom() {
  let np = resolveNodePath();
  if (np !== null) return np;
  log("jsdom not found — attempting `npm install jsdom` (needs network)…");
  const r = spawnSync("npm", ["install", "jsdom@24", "--no-save", "--silent"],
    { cwd: ROOT, stdio: "inherit" });
  if (r.status === 0 && fs.existsSync(path.join(ROOT, "node_modules", "jsdom")))
    return path.join(ROOT, "node_modules");
  return null;
}

// ── 3. Generate analysis JSON (optional; needs Python + libclang) ──────────
function pythonOk() {
  const r = spawnSync("python3", ["-c", "import clang.cindex"], { encoding: "utf8" });
  return r.status === 0;
}
// Build the sample workspace so GCC emits the .su (stack-usage) files the peak
// computation reads, and point compile_commands.json at this checkout's path so
// the analysis works regardless of where the repo was cloned.
function prepareWorkspace() {
  // Rewrite compile_commands.json "directory" to the current workspace path.
  const cc = path.join(WS, "compile_commands.json");
  try {
    const arr = JSON.parse(fs.readFileSync(cc, "utf8"));
    for (const e of arr) e.directory = WS;
    fs.writeFileSync(cc, JSON.stringify(arr, null, 2));
  } catch (e) { /* leave as-is if missing */ }
  // Produce .su files via `make` (Makefile uses -fstack-usage).
  const r = spawnSync("make", ["-C", WS], { encoding: "utf8" });
  if (r.status !== 0) log("make (workspace build) failed: " + (r.stderr || r.stdout || ""));
  return r.status === 0;
}
function generateAnalysis() {
  fs.mkdirSync(TMP, { recursive: true });
  prepareWorkspace();
  const base = ["-m", "cdepth_cli", "--root", WS, "--su-dir", BUILD,
                "--cache-dir", path.join(TMP, "cache")];
  const env = { ...process.env, PYTHONPATH: ROOT };
  let ok = true;
  let r = spawnSync("python3", [...base, "--out", ALLF], { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) { ok = false; log(r.stderr || r.stdout || "analysis (allf) failed"); }
  r = spawnSync("python3", [...base, "--root-pattern", "**/public/**", "--out", ALLFP],
    { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) { ok = false; log(r.stderr || r.stdout || "analysis (allfp) failed"); }
  return ok;
}

// ── Suite registry ─────────────────────────────────────────────────────────
// kind: "js-ui" (needs jsdom), "js" (plain node), "js-analysis" (node + ALLF),
//       "py-analysis" (python + ALLF/ALLFP), "py" (python only).
const SUITES = [
  { file: "webview-harness.js",         kind: "js-ui" },
  { file: "graph-search-test.js",       kind: "js-ui" },
  { file: "collapsible-reveal-test.js", kind: "js-ui" },
  { file: "fp-site-link-test.js",       kind: "js-ui" },
  { file: "edge-over-node-test.js",     kind: "js-ui" },
  { file: "context-menu-test.js",       kind: "js" },
  { file: "per-root-graph-test.js",     kind: "js" },
  { file: "decoration-hover-test.js",   kind: "js" },
  { file: "recursion-path-test.js",     kind: "js" },
  { file: "depth-consistency-test.js",  kind: "js" },
  { file: "fp-advanced-test.js",        kind: "js-analysis", arg: ALLF },
  { file: "fp-struct-runtime-test.js",  kind: "js-analysis", arg: ALLF },
  { file: "generate-template-test.js",  kind: "js-analysis", arg: ALLF },
  { file: "peak-verify-test.py",        kind: "py-analysis", arg: ALLF },
  { file: "examples-count-test.py",     kind: "py-analysis", arg: ALLF },
  { file: "pinned-root-test.py",        kind: "py-analysis", arg: ALLFP },
  { file: "fp-override-test.py",        kind: "py" },
  { file: "edge-removal-test.py",       kind: "py" },
];

function run() {
  fixCompileCommands();
  const nodePath = ensureJsdom();
  const havePy = pythonOk();
  let haveAnalysis = false;
  if (havePy) {
    log("Generating analysis JSON from the bundled workspace…");
    haveAnalysis = generateAnalysis();
  }

  if (nodePath === null)
    log("\n⚠ jsdom unavailable — webview UI suites will be skipped.\n");
  if (!havePy)
    log("\n⚠ Python 3 + libclang unavailable — Python/analysis suites will be skipped.\n");

  let pass = 0, fail = 0, skip = 0;
  const failed = [];

  for (const s of SUITES) {
    const isPy = s.file.endsWith(".py");
    const needsJsdom = s.kind === "js-ui";
    const needsAnalysis = s.kind === "js-analysis" || s.kind === "py-analysis";

    if (isPy && !havePy) { skip++; log(`\n⏭  ${s.file} (skipped: no Python/libclang)`); continue; }
    if (needsJsdom && nodePath === null) { skip++; log(`\n⏭  ${s.file} (skipped: no jsdom)`); continue; }
    if (needsAnalysis && !haveAnalysis) { skip++; log(`\n⏭  ${s.file} (skipped: analysis not generated)`); continue; }

    hr();
    log(`▶ ${s.file}`);
    const args = isPy ? [path.join(TEST, s.file)] : [path.join(TEST, s.file)];
    if (s.arg) args.push(s.arg);
    const env = { ...process.env };
    if (!isPy && nodePath) env.NODE_PATH = nodePath;
    if (isPy) env.PYTHONPATH = ROOT;
    const r = spawnSync(isPy ? "python3" : "node", args, { cwd: ROOT, env, encoding: "utf8" });
    process.stdout.write(r.stdout || "");
    if (r.stderr && r.status !== 0) process.stdout.write(r.stderr);
    if (r.status === 0) pass++; else { fail++; failed.push(s.file); }
  }

  hr();
  log(`\nSUMMARY: ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (failed.length) log("Failed: " + failed.join(", "));
  log(fail === 0 ? "ALL RUN SUITES PASS ✓" : "SOME SUITES FAILED ✗");
  process.exit(fail === 0 ? 0 : 1);
}

run();
