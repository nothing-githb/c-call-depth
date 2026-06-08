// End-to-end "big workspace" test. Generates a COMPLEX ~3000-function C workspace
// (high fan-in/out hubs, deep chain, recursion, function pointers), runs the REAL
// libclang + .su analysis pipeline, and verifies that every view (Function tab,
// Overview, hover, call graph) is consistent/correct on it. Then it verifies that
// changes propagate to ALL views:
//   (A) a CODE change   (regenerated sources, --variant 1)
//   (B) JSON changes    (edge-removals.json and fp-overrides.json)
//
// Needs python3 + libclang. If unavailable it SKIPS (exit 0), like the other
// analysis-tier suites.
//
// Usage: node test/big-workspace-test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runChecks } = require("./cross-view-consistency-test.js");

const REPO = path.join(__dirname, "..");
const N = 3000;

function findPython() {
  for (const p of ["python3", "python"]) {
    const r = spawnSync(p, ["-c", "import clang.cindex"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}
const PY = findPython();
if (!PY) { console.log("⏭  big-workspace-test skipped (python3 + libclang unavailable)"); process.exit(0); }

const TMP = path.join(os.tmpdir(), "cdepth-bigws");
function gen(dir, variant) {
  const args = [path.join("test", "gen_big_workspace.py"), dir, String(N)];
  if (variant) args.push("--variant", String(variant));
  const r = spawnSync(PY, args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error("generator failed: " + (r.stderr || r.stdout));
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
function analyze(dir, extra = []) {
  const out = path.join(dir, "_analysis.json");
  const args = ["-m", "cdepth_cli", "--root", dir, "--su-dir", path.join(dir, "build"),
    "--compile-commands-dir", dir, "--cache-dir", path.join(dir, "cache"),
    "--root-pattern", "**/public/**", "--out", out, ...extra];
  const r = spawnSync(PY, args, {
    cwd: REPO, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO }, maxBuffer: 1 << 26,
  });
  if (r.status !== 0) throw new Error("analyze failed: " + (r.stderr || r.stdout));
  return JSON.parse(fs.readFileSync(out, "utf8"));
}
function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

let failed = 0;
function note(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}
function consistency(label, data) {
  const r = runChecks(data);
  const fails = r.log.filter(l => l.startsWith(" FAIL"));
  note(`${label}: cross-view consistency (${r.total} checks)`, r.failed === 0, fails.join(" | "));
}
const setOf = a => new Set(a);
const minus = (a, b) => a.filter(x => !b.has(x));

console.log(`Generating + analyzing a ${N}-function complex workspace (python=${PY})…\n`);

// ─────────────────────────── (0) BASE ───────────────────────────
const baseDir = path.join(TMP, "base");
const sum = gen(baseDir, 0);
note("base: generated complex workspace (dozens of hubs with dozens of callers AND callees)",
  sum.functions === N && sum.hubsWithBigFanInOut >= 20 && sum.maxFanIn >= 20 && sum.maxFanOut >= 20,
  JSON.stringify({ fns: sum.functions, hubs: sum.hubsWithBigFanInOut, maxIn: sum.maxFanIn, maxOut: sum.maxFanOut, chain: sum.chainLen }));
const base = analyze(baseDir);
const bn = base.byName;
note("base: analyzer recovered all functions", Object.keys(bn).length === N, `got ${Object.keys(bn).length}`);
note("base: recursion present (self/mutual/cycles)", Object.values(bn).filter(f => f.recursive).length >= 90);
note("base: function pointers resolved (indirect edges)", Object.values(bn).filter(f => (f.indirect || []).length).length >= 20);
note("base: unbound fp sites present", Object.values(bn).filter(f => (f.fpSites || []).some(s => !s.overridden && (s.candidates || []).length === 0)).length >= 20);
consistency("base", base);

// ─────────────────────── (A) CODE CHANGE ────────────────────────
// variant 1: drop HUBS[0]'s first leaf edge, add ROOTS[0]->CHAIN[100], bump HUBS[1] stack.
const varDir = path.join(TMP, "variant");
gen(varDir, 1);
const vaFull = analyze(varDir);
const va = vaFull.byName;
const removedLeaf = minus(bn.g00020.callees, setOf(va.g00020.callees));
note("code change: the dropped hub edge disappears from the graph (exactly one fewer callee)",
  va.g00020.callees.length === bn.g00020.callees.length - 1 && removedLeaf.length === 1
  && minus(va.g00020.callees, setOf(bn.g00020.callees)).length === 0,
  `removed=${JSON.stringify(removedLeaf)}`);
note("code change: the new edge g00000->g00160 appears only in the changed build",
  va.g00000.callees.includes("g00160") && !bn.g00000.callees.includes("g00160"));
note("code change: the changed stack frame is reflected (g00021 = 9000B)",
  va.g00021.stackBytes === 9000 && bn.g00021.stackBytes !== 9000);
note("code change: the stack change propagates into the peak (g00021 peak rose by ~frame delta)",
  va.g00021.peak - bn.g00021.peak >= 7000, `delta=${va.g00021.peak - bn.g00021.peak}`);
consistency("after code change (variant)", vaFull);

// ─────────────────── (B1) JSON: edge-removals ───────────────────
const leafA = bn.g00020.callees.find(c => !sum.roots.includes(c) && c >= "g00440"); // a leaf callee
const leafB = bn.g00020.callees.filter(c => c !== leafA && c >= "g00440")[0];
const g21leaf = bn.g00021.callees.find(c => c >= "g00440");
writeJson(baseDir, "edge-removals.json", {
  removals: [
    { caller: "g00020", callee: leafA },                                       // unconditional global
    { caller: "g00020", callee: leafB, when: { callerContains: "g00000" } },   // conditional (g00000 reaches g00020) -> removed
    { caller: "g00021", callee: g21leaf, when: { callerContains: "g99999" } }, // condition false (g99999 doesn't exist) -> kept
  ],
});
const rm = analyze(baseDir, ["--edge-removals", path.join(baseDir, "edge-removals.json")]);
note("json (edge-removals): unconditional edge removed everywhere", !rm.byName.g00020.callees.includes(leafA), `leafA=${leafA}`);
note("json (edge-removals): satisfied conditional edge removed globally", !rm.byName.g00020.callees.includes(leafB), `leafB=${leafB}`);
note("json (edge-removals): unsatisfied conditional edge is kept", rm.byName.g00021.callees.includes(g21leaf), `g21leaf=${g21leaf}`);
note("json (edge-removals): other edges untouched", rm.byName.g00020.callees.length === bn.g00020.callees.length - 2);
consistency("after edge-removals.json", rm);
fs.rmSync(path.join(baseDir, "edge-removals.json"));

// ─────────────────── (B2) JSON: fp-overrides ────────────────────
const tblVia = (bn.g00360.fpSites[0] || {}).via;          // resolved table dispatcher
const tblTarget = bn.g00360.indirect[0];
const unbVia = (bn.g00361.fpSites[0] || {}).via;          // unbound param dispatcher
writeJson(baseDir, "fp-overrides.json", {
  overrides: [
    { caller: "g00360", via: tblVia, targets: [tblTarget] },   // narrow + verify
    { caller: "g00361", via: unbVia, targets: ["g00500"] },    // bind the unbound site
  ],
});
const fp = analyze(baseDir, ["--fp-overrides", path.join(baseDir, "fp-overrides.json")]);
note("json (fp-overrides): table dispatcher narrowed to the bound target",
  fp.byName.g00360.indirect.length < bn.g00360.indirect.length && fp.byName.g00360.indirect.includes(tblTarget),
  `before=${bn.g00360.indirect.length} after=${JSON.stringify(fp.byName.g00360.indirect)}`);
note("json (fp-overrides): narrowed dispatcher is now marked verified/bound", fp.byName.g00360.fpVerified === true);
note("json (fp-overrides): the unbound dispatcher is now bound to its target",
  fp.byName.g00361.indirect.includes("g00500") && fp.byName.g00361.fpVerified === true,
  `indirect=${JSON.stringify(fp.byName.g00361.indirect)} verified=${fp.byName.g00361.fpVerified}`);
consistency("after fp-overrides.json", fp);
fs.rmSync(path.join(baseDir, "fp-overrides.json"));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }

console.log(failed === 0
  ? `\nBIG-WORKSPACE: PASS — ${N}-fn complex workspace stays consistent across all views, and code + JSON changes propagate correctly.`
  : `\nBIG-WORKSPACE: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
