// Tests the fp-overrides suggester on RUNTIME struct-field assignments:
//   - conditional assignment in the same function (precise: both branches)
//   - reassignment before the call (precise: both assigned targets)
//   - global struct assigned in one function, invoked in another (safe
//     over-approximation: at least the real targets, never missing any)
//   - assignment through a struct-pointer parameter (safe over-approximation)
//
// The key correctness property for DO-178C is NEVER MISSING a real target;
// same-function cases are additionally checked to be precise (no extras).
//
// Usage: node test/fp-struct-runtime-test.js <analysis.json>
const fs = require("fs");
const Module = require("module");
const realLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return {}; return realLoad.apply(this, arguments); };
const { buildFpTemplate } = require("../out/fpTemplate.js");

const data = JSON.parse(fs.readFileSync(process.argv[2] || "/tmp/fps3.json", "utf8"));
const byName = new Map();
const depth = new Map();
for (const [n, r] of Object.entries(data.byName)) {
  byName.set(n, { file: r.file });
  depth.set(n, { fpSites: r.fpSites || [] });
}
const { entries } = buildFpTemplate(depth, byName);
const byCaller = {};
for (const e of entries) (byCaller[e.caller] = byCaller[e.caller] || []).push(e);

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}
function targets(caller) {
  const s = new Set();
  for (const e of (byCaller[caller] || [])) for (const t of (e.targets || [])) s.add(t);
  return [...s];
}
function isExactly(caller, want) {
  const got = targets(caller).sort();
  const w = [...want].sort();
  return got.length === w.length && got.every((x, i) => x === w[i]);
}
function containsAll(caller, want) {
  const got = new Set(targets(caller));
  return want.every(t => got.has(t));
}

// Precise (same-function assignments): exact set, no extras.
check("conditional: both branches suggested, nothing extra (a, c)",
      isExactly("fps_conditional_root", ["fps_handler_a", "fps_handler_c"]),
      `got [${targets("fps_conditional_root").join(", ")}]`);
check("reassignment: both assigned targets suggested (a, d)",
      isExactly("fps_reassign_root", ["fps_handler_a", "fps_handler_d"]),
      `got [${targets("fps_reassign_root").join(", ")}]`);

// Safe over-approximation (cross-function): must include the real targets;
// extras are acceptable (the analyzer never misses a target).
check("global struct (assigned in setup, called in invoke): real targets present (b, d)",
      containsAll("fps_global_invoke", ["fps_handler_b", "fps_handler_d"]),
      `got [${targets("fps_global_invoke").join(", ")}]`);
check("pointer-param config: real targets present (a, c)",
      containsAll("fps_ptr_param_root", ["fps_handler_a", "fps_handler_c"]),
      `got [${targets("fps_ptr_param_root").join(", ")}]`);

// None of these should be empty (a missing suggestion would be an
// under-approximation — the dangerous direction).
for (const fn of ["fps_conditional_root", "fps_global_invoke", "fps_ptr_param_root", "fps_reassign_root"]) {
  check(`${fn}: has at least one suggested target (no under-approximation)`,
        targets(fn).length > 0, `got [${targets(fn).join(", ")}]`);
}

console.log(failed === 0
  ? "\nFP-STRUCT-RUNTIME: PASS — runtime struct-field assignments resolved (precise in-function, safe cross-function)."
  : `\nFP-STRUCT-RUNTIME: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
