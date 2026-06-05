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

// Expected targets per call site (matches the shared template, PLUS the
// assignment-derived handler_large for fp_global_dispatch which was missing).
const EXPECT = {
  dispatch_isr: ["isr_timer", "isr_watchdog", "isr_uart", "isr_spi", "isr_i2c", "isr_dma", "isr_eth", "isr_usb"],
  fp_array_dispatch: ["handler_small", "handler_medium", "handler_large"],
  fp_global_dispatch: ["handler_small", "handler_large"], // <-- assignment-derived handler_large MUST be present
  fp_param_apply: ["handler_large"], // inter-procedural: caller passes handler_large at param 0
  fp_returned_dispatch: ["pick"],
  fp_struct_dispatch: ["handler_medium", "handler_small"],
};

for (const [caller, want] of Object.entries(EXPECT)) {
  const got = targetsOf(caller);
  check(`${caller} targets = [${want.join(", ")}]`, sameSet(got, want),
        `got [${got ? got.join(", ") : "(missing entry)"}]`);
}

// Structural checks the shared template implies.
check("every entry has caller + file (no line numbers)",
      entries.every(e => e.caller && "file" in e));
check("no entry carries a `line` field (line removed from template)",
      entries.every(e => !("line" in e)));
check("entries with candidates carry `via` (except unresolved)",
      entries.every(e => e.targets.length === 0 || typeof e.via === "string"));
check("JSON has _comment + overrides[]", /"_comment"/.test(json) && /"overrides"/.test(json));

// Specifically pin the regression the user hit: handler_large present for global.
const gl = targetsOf("fp_global_dispatch") || [];
check("REGRESSION: fp_global_dispatch includes handler_large (assignment-derived)",
      gl.includes("handler_large"), `got [${gl.join(", ")}]`);

console.log(failed === 0
  ? "\nGENERATE-TEMPLATE: PASS — all targets match expected."
  : `\nGENERATE-TEMPLATE: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
