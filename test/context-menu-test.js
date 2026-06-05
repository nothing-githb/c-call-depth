// Verifies the side panel and call graph right-click (context) menus share the
// same mentality: identical action vocabulary, and a clear separation between
// read-only INFO (Frame/Peak) and ACTIONS (separated by a rule).
//
// It checks the source of both webviews (no DOM needed) for the agreed labels.
//
// Run: node test/context-menu-test.js
const fs = require("fs");
const path = require("path");

const graphSrc = fs.readFileSync(path.join(__dirname, "..", "src", "graphView.ts"), "utf8");
const panelSrc = fs.readFileSync(path.join(__dirname, "..", "src", "sidePanel.ts"), "utf8");

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

// The shared action vocabulary both menus must use verbatim.
const ACTIONS = ["Open source", "Show details in side panel", "Focus in call graph"];

for (const label of ACTIONS) {
  check(`graph menu has action: "${label}"`, graphSrc.includes(label));
  check(`side panel menu has action: "${label}"`, panelSrc.includes(label));
}

// Old/inconsistent labels must be gone (so the two menus don't drift in wording).
const RETIRED = ["Make root (focus here)", "Already the root", "Show stack usage", "Look up in panel", "View in call graph"];
for (const old of RETIRED) {
  check(`retired label not in graph: "${old}"`, !graphSrc.includes(old));
  check(`retired label not in side panel: "${old}"`, !panelSrc.includes(old));
}

// Info vs actions separation: both menus must render Frame/Peak info and a
// separator element between info and actions.
check("graph menu shows Frame info", /Frame: /.test(graphSrc));
check("graph menu shows Peak info", /Peak: /.test(graphSrc));
check("graph menu has an info/action separator (ctx-sep)", /ctx-sep/.test(graphSrc));

check("side panel menu has info section (ctx-info)", /ctx-info/.test(panelSrc));
check("side panel menu has an info/action separator (ctx-sep)", /ctx-sep/.test(panelSrc));
check("side panel requests Frame/Peak info for the menu", /requestFnInfo/.test(panelSrc));
check("side panel fills info with Frame/Peak", /Frame: /.test(panelSrc) && /Peak: /.test(panelSrc));

// Hover tooltips: both views show name + info on node/link hover (not just the
// bare name). Graph uses an SVG <title> with Frame/Peak; the side panel sets a
// native title on function links via the same requestFnInfo data.
check("graph node tooltip includes Frame/Peak", /Frame: '/.test(graphSrc) === false ? /Frame: /.test(graphSrc) : true);
check("graph node tooltip built from name + info parts", /tparts\.push\('Frame: '/.test(graphSrc) && /tparts\.push\('Peak: '/.test(graphSrc));
check("side panel sets a hover title on function links", /setAttribute\('title'/.test(panelSrc));
check("side panel hover requests Frame/Peak (reuses requestFnInfo)",
      /mouseenter/.test(panelSrc) && /requestFnInfo/.test(panelSrc) && /fnInfoCache/.test(panelSrc));

// File name in both menus' info section + both hover tooltips.
check("graph menu info includes File", /File: '/.test(graphSrc) || /'File: '/.test(graphSrc) || /File: /.test(graphSrc));
check("graph fnInfo carries file basename in tooltip", /File: ' \+ n\.file/.test(graphSrc));
check("side panel menu info includes File", /File: /.test(panelSrc));
check("side panel fnInfo provides file", /file: rec/.test(panelSrc));
check("side panel computes a basename (no regex literal)", /function baseName/.test(panelSrc));
// Action ORDER should match: Open source → details → graph focus.
function order(src) {
  return ACTIONS.map(a => src.indexOf(a));
}
const go = order(graphSrc).filter(i => i >= 0);
const po = order(panelSrc).filter(i => i >= 0);
check("graph actions in canonical order", go.length === 3 && go[0] < go[1] && go[1] < go[2]);
check("side panel actions in canonical order", po.length === 3 && po[0] < po[1] && po[1] < po[2]);

console.log(failed === 0
  ? "\nCONTEXT-MENU: PASS — both menus share vocabulary, order, and info/action split."
  : `\nCONTEXT-MENU: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
