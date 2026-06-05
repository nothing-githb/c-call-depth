// Tests the fp-overrides template builder on HARD inter-procedural / struct
// cases, using the real src/fpTemplate.ts against CLI output:
//   - callback forwarded through THREE parameter levels
//   - a wrapper that forwards a received callback
//   - multiple fp parameters, each resolved independently
//   - struct-field assignment (s.field = fn) surfaced as a candidate
//   - array-of-struct fp fields
//
// Usage: node test/fp-advanced-test.js <analysis.json>
//   analysis.json must be produced by the CLI on the big-workspace (which now
//   contains the fpadvanced module).
const fs = require("fs");
const Module = require("module");
const realLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return {}; return realLoad.apply(this, arguments); };
const { buildFpTemplate } = require("../out/fpTemplate.js");

const data = JSON.parse(fs.readFileSync(process.argv[2] || "/tmp/adv.json", "utf8"));
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
function has(caller, target) {
  return (byCaller[caller] || []).some(e => (e.targets || []).includes(target));
}
function siteVia(caller, via) {
  return (byCaller[caller] || []).find(e => e.via === via);
}
function allTargets(caller) {
  const s = new Set();
  for (const e of (byCaller[caller] || [])) for (const t of (e.targets || [])) s.add(t);
  return [...s];
}

// 1) Three-level parameter callback: adv_lvl3_bottom invokes cb (param 0); the
//    concrete adv_h_large is supplied 3 forwarding levels up at adv_lvl3_root.
check("3-level callback: adv_lvl3_bottom suggests adv_h_large",
      has("adv_lvl3_bottom", "adv_h_large"),
      `got [${allTargets("adv_lvl3_bottom").join(", ")}]`);

// 2) Wrapper: adv_invoke gets adv_h_medium via adv_forward <- adv_wrapper_root.
check("wrapper: adv_invoke suggests adv_h_medium",
      has("adv_invoke", "adv_h_medium"),
      `got [${allTargets("adv_invoke").join(", ")}]`);

// 3) Multiple fp parameters resolved independently by position.
check("multi-param: adv_apply2 param a -> adv_h_small",
      !!siteVia("adv_apply2", "a") && siteVia("adv_apply2", "a").targets.includes("adv_h_small"),
      `got [${allTargets("adv_apply2").join(", ")}]`);
check("multi-param: adv_apply2 param b -> adv_h_large",
      !!siteVia("adv_apply2", "b") && siteVia("adv_apply2", "b").targets.includes("adv_h_large"));
check("multi-param: adv_apply3 has three distinct sites",
      (byCaller["adv_apply3"] || []).length === 3,
      `got ${(byCaller["adv_apply3"] || []).length} sites`);
check("multi-param: adv_apply3 a->medium b->huge c->small",
      siteVia("adv_apply3", "a") && siteVia("adv_apply3", "a").targets.includes("adv_h_medium") &&
      siteVia("adv_apply3", "b") && siteVia("adv_apply3", "b").targets.includes("adv_h_huge") &&
      siteVia("adv_apply3", "c") && siteVia("adv_apply3", "c").targets.includes("adv_h_small"));

// 4) Struct-field assignment: s.field = fn must be surfaced; via = field name.
check("struct-field: adv_struct_assign_root on_event -> adv_h_huge",
      !!siteVia("adv_struct_assign_root", "on_event") &&
      siteVia("adv_struct_assign_root", "on_event").targets.includes("adv_h_huge"),
      `got [${allTargets("adv_struct_assign_root").join(", ")}]`);
check("struct-field: adv_struct_assign_root on_error -> adv_h_small",
      !!siteVia("adv_struct_assign_root", "on_error") &&
      siteVia("adv_struct_assign_root", "on_error").targets.includes("adv_h_small"));
check("struct-field: via carries the FIELD name (not the variable)",
      !!siteVia("adv_struct_assign_root", "on_event"));

// 5) Array-of-struct fp field: all three table targets surfaced.
check("array-of-struct: adv_array_struct_root suggests all three handlers",
      has("adv_array_struct_root", "adv_h_small") &&
      has("adv_array_struct_root", "adv_h_medium") &&
      has("adv_array_struct_root", "adv_h_large"),
      `got [${allTargets("adv_array_struct_root").join(", ")}]`);

console.log(failed === 0
  ? "\nFP-ADVANCED: PASS — multi-level callbacks, multi-param, and struct-field assignments resolved."
  : `\nFP-ADVANCED: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
