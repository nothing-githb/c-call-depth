// Tests the REAL fp-overrides template builder (src/fpTemplate.ts) against
// actual CLI output, asserting each call site's pre-filled `targets`.
// This is the exact code path the "Generate fp-overrides template" command
// uses, so passing here means the command produces these targets.
//
// Usage: node test/generate-template-test.js [path-to-analysis.json]
//   If no path is given, it expects /tmp/gen.json (produced by the CLI).
const fs = require("fs");
const Module = require("module");

// fpTemplate.ts only imports "path" + types, but extension types pull nothing
// at runtime; still, stub vscode in case of transitive requires.
const realLoad = Module._load;
Module._load = function (r) {
  if (r === "vscode") return {};
  return realLoad.apply(this, arguments);
};
const { buildFpTemplate, fpTemplateToJson } = require("../out/fpTemplate.js");

const analysisPath = process.argv[2] || "/tmp/gen.json";
const data = JSON.parse(fs.readFileSync(analysisPath, "utf8"));

// Rebuild the maps exactly as the extension does (byName + depth.fpSites).
const byName = new Map();
const depth = new Map();
for (const [n, r] of Object.entries(data.byName)) {
  byName.set(n, { file: r.file });
  depth.set(n, { fpSites: r.fpSites || [] });
}

const { entries } = buildFpTemplate(depth, byName);
const json = fpTemplateToJson({ entries, covered: 0 });
const byCaller = Object.fromEntries(entries.map(e => [e.caller, e]));

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}
function targetsOf(caller) { return byCaller[caller] ? byCaller[caller].targets : undefined; }
function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

// Over-approximation is removed: the template no longer SUGGESTS targets. It
// lists the fp call SITES (so you know where to bind) with EMPTY `targets` for
// you to fill in fp-overrides.json. Verify each known dispatcher is listed and
// carries no pre-filled targets.
const SITES = ["dispatch_isr", "fp_array_dispatch", "fp_global_dispatch",
               "fp_param_apply", "fp_returned_dispatch", "fp_struct_dispatch"];
for (const caller of SITES) {
  check(`${caller} is listed as an fp call site to bind`, !!byCaller[caller], "(missing entry)");
}
check("listed sites have NO pre-filled targets (no over-approximation / suggestion)",
      entries.length > 0 && entries.every(e => Array.isArray(e.targets) && e.targets.length === 0),
      entries.map(e => `${e.caller}:[${e.targets}]`).join(" "));
check("every entry has caller + file (no line numbers)",
      entries.every(e => e.caller && "file" in e && !("line" in e)));
check("each entry carries a `via` field to identify the call site",
      entries.every(e => "via" in e));
check("JSON has _comment + overrides[]", /"_comment"/.test(json) && /"overrides"/.test(json));

console.log(failed === 0
  ? "\nGENERATE-TEMPLATE: PASS — all targets match expected."
  : `\nGENERATE-TEMPLATE: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
