// src/reporter.ts
// Export the analysis as CSV or HTML — one row per (function, root) pair.
// This is what DO-178C review uses: a tangible artifact independent of the
// IDE. (Note: this report is NOT a tool-qualified output. It's a convenient
// summary for human review. For Level A certification evidence you need a
// qualified tool like AbsInt StackAnalyzer.)

import { FunctionRecord, DepthInfo } from "./callGraph";

export interface ReportConfig {
  thresholdWarn: number;
  thresholdCritical: number;
}

interface Row {
  fn: string;
  file: string;
  line: number;
  root: string;
  rootKind: "pinned" | "auto" | "unreached" | "self";
  depth: number;
  depthBounded: boolean;
  ownFrame: number | undefined;
  ownQualifier: string | undefined;
  peak: number | undefined;
  bounded: boolean;
  recursive: boolean;
  ghost: boolean;
  severity: "ok" | "warn" | "critical" | "unknown";
}

function severity(peak: number | undefined, cfg: ReportConfig): Row["severity"] {
  if (peak === undefined) return "unknown";
  if (peak <= cfg.thresholdWarn) return "ok";
  if (peak <= cfg.thresholdCritical) return "warn";
  return "critical";
}

/** Build a flat row list. By default one row per (function, root) pair.
 *  When `rootsOnly` is set, emit only the entry-point functions themselves —
 *  one row per root (pinned or auto), each with that root's own peak. */
export function buildRows(
  byName: Map<string, FunctionRecord>,
  depth: Map<string, DepthInfo>,
  pinnedRoots: ReadonlySet<string>,
  cfg: ReportConfig,
  rootsOnly: boolean = false
): Row[] {
  const rows: Row[] = [];
  for (const [name, rec] of byName) {
    const info = depth.get(name);
    if (!info) continue;
    // Roots-only mode shows EXACTLY the entry points: a function is a root iff
    // it is a pinned root or an auto root (caller-less). The analyzer reports
    // this authoritatively; an interior function that happens to carry a
    // perRoot entry for itself (e.g. tagged by a too-broad pinned pattern) is
    // NOT treated as a root here.
    const isSelfRoot =
      info.isPinnedRoot === true ||
      info.isAutoRoot === true ||
      // Legacy fallback: no per-root data at all and a genuine caller-less
      // entry (depth === 1), only when no pinned roots are configured.
      (pinnedRoots.size === 0 && info.perRoot.length === 0 && info.depth === 1);
    if (rootsOnly && !isSelfRoot) continue;

    const entries = info.perRoot.length > 0 ? info.perRoot : [{
      rootName: "(auto)",
      depth: info.depth,
      cumulativeStack: info.cumulativeStack,
      cumulativeBounded: info.cumulativeBounded
    }];
    for (const e of entries) {
      // In roots-only mode keep just the self entry (the root's own chain),
      // so each root contributes exactly one row with its full downward peak.
      if (rootsOnly && e.rootName !== name &&
          !(info.perRoot.length === 0 && e.rootName === "(auto)")) {
        continue;
      }
      let rootKind: Row["rootKind"];
      if (e.rootName === name) rootKind = "self";
      else if (e.rootName === "(auto)") rootKind = "auto";
      else if (e.rootName === "(unreached)") rootKind = "unreached";
      else rootKind = pinnedRoots.has(e.rootName) ? "pinned" : "auto";
      rows.push({
        fn: name,
        file: rec.file,
        line: rec.nameLine + 1,
        root: e.rootName,
        rootKind,
        // "Longest calls-into": number of call steps in the deepest downward
        // chain from this function (the function itself isn't a step, so it's
        // downDepth - 1). A leaf is 0.
        depth: Math.max(0, (info.downDepth ?? e.depth) - 1),
        depthBounded: info.downDepthBounded === true,
        ownFrame: rec.stackBytes,
        ownQualifier: rec.stackQualifier,
        peak: e.cumulativeStack,
        bounded: e.cumulativeBounded === true,
        recursive: info.recursive,
        ghost: rec.ghost === true,
        severity: severity(e.cumulativeStack, cfg)
      });
    }
  }
  // Sort: critical first (so the most dangerous rows are at the top), then by
  // peak desc, then function name for stable diffs.
  const sevOrder = { critical: 0, warn: 1, ok: 2, unknown: 3 };
  rows.sort((a, b) => {
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    const ap = a.peak ?? -1, bp = b.peak ?? -1;
    if (ap !== bp) return bp - ap;
    if (a.fn !== b.fn) return a.fn.localeCompare(b.fn);
    return a.root.localeCompare(b.root);
  });
  return rows;
}

function csvEscape(s: string | number | undefined): string {
  if (s === undefined) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function buildCsv(rows: Row[]): string {
  const lines: string[] = [];
  lines.push(["function", "file", "line", "root", "root_kind", "longest_calls_into",
    "own_frame_bytes", "own_qualifier",
    "peak_stack_bytes", "peak_bounded", "recursive", "ghost", "severity"].join(","));
  for (const r of rows) {
    lines.push([
      csvEscape(r.fn),
      csvEscape(r.file),
      csvEscape(r.line),
      csvEscape(r.root),
      csvEscape(r.rootKind),
      csvEscape(r.depth),
      csvEscape(r.ownFrame),
      csvEscape(r.ownQualifier),
      csvEscape(r.peak),
      csvEscape(r.bounded ? "yes" : "no"),
      csvEscape(r.recursive ? "yes" : "no"),
      csvEscape(r.ghost ? "yes" : "no"),
      csvEscape(r.severity)
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildHtml(rows: Row[], cfg: ReportConfig, meta: {
  workspace: string;
  generatedAt: Date;
  totalFunctions: number;
  pinnedRoots: number;
}): string {
  const totals = {
    rows: rows.length,
    critical: rows.filter(r => r.severity === "critical").length,
    warn: rows.filter(r => r.severity === "warn").length,
    bounded: rows.filter(r => r.bounded).length,
    recursive: new Set(rows.filter(r => r.recursive).map(r => r.fn)).size,
    ghosts: new Set(rows.filter(r => r.ghost).map(r => r.fn)).size
  };

  const rowsHtml = rows.map(r => {
    const rootCell = r.rootKind === "auto" || r.rootKind === "unreached"
      ? `<em>${htmlEscape(r.root)}</em>`
      : r.rootKind === "self"
        ? `<strong>${htmlEscape(r.root)}</strong> <span class="tag">self</span>`
        : `<strong>${htmlEscape(r.root)}</strong>`;
    const peakCell = r.peak === undefined
      ? '<span class="muted">—</span>'
      : `<span class="sev-${r.severity}">${fmtBytes(r.peak)}${r.bounded ? "+" : ""}</span>`;
    const tags = [];
    if (r.recursive) tags.push('<span class="tag tag-rec">recursive</span>');
    if (r.ghost) tags.push('<span class="tag tag-ghost">ghost</span>');
    if (r.bounded) tags.push('<span class="tag tag-bounded">bounded</span>');
    const peakSort = r.peak === undefined ? -1 : r.peak;
    const searchText = `${r.fn} ${r.file} ${r.root}`.toLowerCase();
    return `<tr class="sev-row-${r.severity}" data-search="${htmlEscape(searchText)}">
      <td data-sort="${htmlEscape(r.fn)}"><code>${htmlEscape(r.fn)}</code> ${tags.join(" ")}</td>
      <td class="file" data-sort="${htmlEscape(r.file)}"><code>${htmlEscape(r.file)}</code><span class="muted">:${r.line}</span></td>
      <td data-sort="${htmlEscape(r.root)}">${rootCell}</td>
      <td class="num" data-sort="${r.depth}">${r.depth}${r.depthBounded ? "+" : ""}</td>
      <td class="num" data-sort="${r.ownFrame ?? -1}">${fmtBytes(r.ownFrame)}${r.ownQualifier ? ` <span class="muted">(${htmlEscape(r.ownQualifier)})</span>` : ""}</td>
      <td class="num" data-sort="${peakSort}">${peakCell}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>C Call Depth Report — ${htmlEscape(meta.workspace)}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b6b6b;
    --border: #e0e0e0; --hover: #f5f5f5;
    --sev-ok: #2e7d32; --sev-warn: #f57c00; --sev-crit: #c62828;
    --bg-crit: #ffebee; --bg-warn: #fff8e1;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1e1e; --fg: #d4d4d4; --muted: #888;
      --border: #3c3c3c; --hover: #2a2d2e;
      --sev-ok: #4caf50; --sev-warn: #ffa726; --sev-crit: #ef5350;
      --bg-crit: #3a1f1f; --bg-warn: #3a2f1f;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: var(--bg); color: var(--fg); margin: 0; padding: 24px; line-height: 1.5; }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
             gap: 12px; margin-bottom: 24px; }
  .stat-box { border: 1px solid var(--border); border-radius: 4px; padding: 12px; }
  .stat-box .v { font-size: 24px; font-weight: 600; font-family: ui-monospace, monospace; }
  .stat-box .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-box.crit .v { color: var(--sev-crit); }
  .stat-box.warn .v { color: var(--sev-warn); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border);
             font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px;
             color: var(--muted); position: sticky; top: 0; background: var(--bg); }
  thead th.sortable { cursor: pointer; user-select: none; }
  thead th.sortable:hover { color: var(--fg); }
  thead th.num { text-align: right; }
  thead th.sorted-asc::after { content: " ▲"; font-size: 9px; }
  thead th.sorted-desc::after { content: " ▼"; font-size: 9px; }
  .controls { margin-bottom: 12px; display: flex; align-items: center; gap: 12px; }
  #search { flex: 0 0 320px; max-width: 60%; padding: 6px 10px; font-size: 13px;
            border: 1px solid var(--border); border-radius: 4px;
            background: var(--bg); color: var(--fg); }
  tbody td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:hover { background: var(--hover); }
  .sev-row-critical { background: var(--bg-crit); }
  .sev-row-warn { background: var(--bg-warn); }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .num { font-family: ui-monospace, monospace; text-align: right; white-space: nowrap; }
  .muted { color: var(--muted); }
  .sev-ok { color: var(--sev-ok); font-weight: 500; }
  .sev-warn { color: var(--sev-warn); font-weight: 600; }
  .sev-critical { color: var(--sev-crit); font-weight: 700; }
  .file { font-size: 11px; color: var(--muted); }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px;
         margin-left: 4px; vertical-align: middle; background: var(--border); }
  .tag-rec { background: rgba(239,83,80,0.2); color: var(--sev-crit); }
  .tag-ghost { background: rgba(128,128,128,0.2); }
  .tag-bounded { background: rgba(255,167,38,0.2); color: var(--sev-warn); }
  .disclaimer { margin-top: 32px; padding: 12px 16px; border-left: 3px solid var(--sev-warn);
                background: var(--bg-warn); font-size: 12px; color: var(--fg); }
  .thresholds { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
</style>
</head>
<body>
<h1>C Call Depth Report</h1>
<div class="meta">
  Workspace: <code>${htmlEscape(meta.workspace)}</code> &nbsp;·&nbsp;
  Generated ${meta.generatedAt.toISOString()}
</div>

<div class="summary">
  <div class="stat-box"><div class="v">${meta.totalFunctions}</div><div class="l">Functions</div></div>
  <div class="stat-box"><div class="v">${meta.pinnedRoots}</div><div class="l">Pinned roots</div></div>
  <div class="stat-box"><div class="v">${totals.rows}</div><div class="l">Analysis rows</div></div>
  <div class="stat-box crit"><div class="v">${totals.critical}</div><div class="l">Critical</div></div>
  <div class="stat-box warn"><div class="v">${totals.warn}</div><div class="l">Warning</div></div>
  <div class="stat-box"><div class="v">${totals.bounded}</div><div class="l">Bounded</div></div>
  <div class="stat-box"><div class="v">${totals.recursive}</div><div class="l">Recursive fns</div></div>
  <div class="stat-box"><div class="v">${totals.ghosts}</div><div class="l">Ghosts</div></div>
</div>

<div class="thresholds">
  Severity thresholds: ok ≤ ${fmtBytes(cfg.thresholdWarn)} &lt; warn ≤ ${fmtBytes(cfg.thresholdCritical)} &lt; critical
</div>

<div class="controls">
  <input id="search" type="text" placeholder="filter by function, file, or root…" autocomplete="off">
  <span id="count" class="muted"></span>
</div>

<table id="report">
  <thead>
    <tr>
      <th class="sortable" data-col="0" data-type="text">Function</th>
      <th class="sortable" data-col="1" data-type="text">File</th>
      <th class="sortable" data-col="2" data-type="text">From root</th>
      <th class="sortable num" data-col="3" data-type="num" title="Length of the longest chain of calls going down from this function (number of call steps; a leaf is 0). '+' means capped by recursion.">Longest calls-into</th>
      <th class="sortable num" data-col="4" data-type="num">Own frame</th>
      <th class="sortable num" data-col="5" data-type="num">Peak</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml}
  </tbody>
</table>

<script>
(function () {
  var table = document.getElementById('report');
  var tbody = table.tBodies[0];
  var search = document.getElementById('search');
  var count = document.getElementById('count');
  var allRows = Array.prototype.slice.call(tbody.rows);
  var sortState = { col: -1, dir: 1 };

  function updateCount() {
    var shown = 0;
    for (var i = 0; i < allRows.length; i++) {
      if (allRows[i].style.display !== 'none') shown++;
    }
    count.textContent = shown + ' / ' + allRows.length + ' rows';
  }

  function applyFilter() {
    var q = search.value.trim().toLowerCase();
    for (var i = 0; i < allRows.length; i++) {
      var hay = allRows[i].getAttribute('data-search') || '';
      allRows[i].style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
    }
    updateCount();
  }

  function sortBy(col, type) {
    sortState.dir = (sortState.col === col) ? -sortState.dir : 1;
    sortState.col = col;
    var rows = allRows.slice();
    rows.sort(function (a, b) {
      var av = a.cells[col].getAttribute('data-sort');
      var bv = b.cells[col].getAttribute('data-sort');
      var cmp;
      if (type === 'num') {
        cmp = (parseFloat(av) || 0) - (parseFloat(bv) || 0);
      } else {
        cmp = String(av).localeCompare(String(bv));
      }
      return cmp * sortState.dir;
    });
    for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
    var ths = table.tHead.rows[0].cells;
    for (var j = 0; j < ths.length; j++) {
      ths[j].classList.remove('sorted-asc', 'sorted-desc');
    }
    ths[col].classList.add(sortState.dir > 0 ? 'sorted-asc' : 'sorted-desc');
  }

  var headers = table.tHead.rows[0].cells;
  for (var c = 0; c < headers.length; c++) {
    (function (idx) {
      headers[idx].addEventListener('click', function () {
        sortBy(idx, headers[idx].getAttribute('data-type'));
      });
    })(c);
  }
  search.addEventListener('input', applyFilter);
  updateCount();
})();
</script>

<div class="disclaimer">
  <strong>Note:</strong> This report is generated by a development-time helper extension.
  It is <em>not</em> a tool-qualified output. For DO-178C / ISO 26262 certification evidence,
  a qualified static stack analyzer (e.g. AbsInt StackAnalyzer) must be used.
  Limitations: indirect calls (function pointers) are not resolved; inline assembly stack
  usage is not counted; the call graph is derived from libclang's best-effort analysis;
  recursion contributes a lower bound only.
</div>
</body>
</html>`;
}
