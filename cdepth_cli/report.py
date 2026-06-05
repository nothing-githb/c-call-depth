"""Render analysis results to a standalone HTML report (and CSV)."""

from __future__ import annotations

import html
import os


def _fmt_bytes(n):
    if n is None:
        return "?"
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n/1024:.1f}KB"
    return f"{n/(1024*1024):.1f}MB"


def _severity(peak, warn=1024, crit=4096):
    if peak is None:
        return "unknown"
    if peak <= warn:
        return "ok"
    if peak <= crit:
        return "warn"
    return "critical"


def _select_rows(result: dict, roots_only: bool) -> list:
    """Return the byName rows to report, sorted by peak desc. When
    `roots_only` is set, keep only entry-point functions (pinned ∪ auto
    roots)."""
    rows = list(result["byName"].values())
    if roots_only:
        roots = set(result.get("pinnedRoots", [])) | set(result.get("autoRoots", []))
        rows = [r for r in rows if r["name"] in roots]
    rows.sort(key=lambda r: -(r["peak"] if r["peak"] is not None else -1))
    return rows


def write_csv_report(result: dict, path: str, warn=1024, crit=4096,
                     roots_only: bool = False) -> None:
    import csv
    rows = _select_rows(result, roots_only)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["function", "file", "line", "frame_bytes", "peak_bytes",
                    "peak_bounded", "max_depth", "recursive", "severity", "callees"])
        for r in rows:
            w.writerow([
                r["name"], r["file"], r["line"] + 1,
                r["stackBytes"] if r["stackBytes"] is not None else "",
                r["peak"] if r["peak"] is not None else "",
                "yes" if r["peakBounded"] else "no",
                r["depth"], "yes" if r["recursive"] else "no",
                _severity(r["peak"], warn, crit),
                ";".join(r["callees"]),
            ])


def write_html_report(result: dict, path: str, warn=1024, crit=4096,
                      roots_only: bool = False) -> None:
    meta = result.get("meta", {})
    rows = _select_rows(result, roots_only)
    n_crit = sum(1 for r in rows if _severity(r["peak"], warn, crit) == "critical")
    n_warn = sum(1 for r in rows if _severity(r["peak"], warn, crit) == "warn")
    n_rec = sum(1 for r in rows if r["recursive"])

    def esc(s):
        return html.escape(str(s))

    tr = []
    for r in rows:
        sev = _severity(r["peak"], warn, crit)
        roots = ", ".join(
            f'{e["root"]}(d{e["depth"]})' for e in r["perRoot"][:6]
        )
        if len(r["perRoot"]) > 6:
            roots += f' +{len(r["perRoot"]) - 6}'
        frame_v = r["stackBytes"] if r["stackBytes"] is not None else -1
        peak_v = r["peak"] if r["peak"] is not None else -1
        sev_rank = {"critical": 3, "warn": 2, "ok": 1, "unknown": 0}[sev]
        loc = f'{os.path.basename(r["file"])}:{r["line"]+1}'
        tr.append(
            f'<tr class="{sev}">'
            f'<td class="fn" data-sort="{esc(r["name"])}">{esc(r["name"])}{" ↻" if r["recursive"] else ""}</td>'
            f'<td class="num" data-sort="{frame_v}">{_fmt_bytes(r["stackBytes"])}</td>'
            f'<td class="num peak" data-sort="{peak_v}">{_fmt_bytes(r["peak"])}{"+" if r["peakBounded"] else ""}</td>'
            f'<td class="num" data-sort="{r["depth"]}">{r["depth"]}</td>'
            f'<td class="sev" data-sort="{sev_rank}">{sev}</td>'
            f'<td class="file" data-sort="{esc(loc)}">{esc(loc)}</td>'
            f'<td class="roots" data-sort="{len(r["perRoot"])}">{esc(roots)}</td>'
            f'</tr>'
        )

    doc = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Stack Analysis Report</title>
<style>
 body {{ font-family: system-ui, sans-serif; margin: 24px; color: #222; }}
 h1 {{ font-size: 20px; }}
 .meta {{ color: #666; font-size: 13px; margin-bottom: 16px; }}
 .cards {{ display: flex; gap: 12px; margin-bottom: 20px; }}
 .card {{ border: 1px solid #ddd; border-radius: 8px; padding: 10px 16px; }}
 .card .v {{ font-size: 22px; font-weight: 700; }}
 .card.crit .v {{ color: #d33; }} .card.warn .v {{ color: #e90; }}
 table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
 th, td {{ text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; }}
 th {{ background: #f6f6f6; position: sticky; top: 0; }}
 td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
 td.peak {{ font-weight: 600; }}
 tr.critical td.sev {{ color: #d33; font-weight: 700; }}
 tr.warn td.sev {{ color: #e90; }}
 tr.critical {{ background: #fdf0f0; }} tr.warn {{ background: #fffaf0; }}
 .fn {{ font-family: ui-monospace, monospace; }}
 .file, .roots {{ color: #666; }}
 th.sortable {{ cursor: pointer; user-select: none; }}
 th.sortable:hover {{ background: #ececec; }}
 th.sortable .arrow {{ color: #999; font-size: 10px; margin-left: 4px; }}
 th.sorted-asc .arrow::after {{ content: "\\25B2"; color: #333; }}
 th.sorted-desc .arrow::after {{ content: "\\25BC"; color: #333; }}
 #filter {{ padding: 6px 10px; font-size: 13px; width: 260px; margin-bottom: 12px;
   border: 1px solid #ccc; border-radius: 6px; }}
 .hidden {{ display: none; }}
 #count {{ color: #666; font-size: 12px; margin-left: 10px; }}
</style></head><body>
<h1>C Call-Depth &amp; Stack Analysis</h1>
<div class="meta">root: {esc(meta.get("root",""))} &middot;
 {meta.get("functionCount",len(rows))} functions &middot;
 {meta.get("fileCount","?")} files &middot;
 generated {esc(meta.get("generatedAt",""))} &middot;
 thresholds warn {warn}B / critical {crit}B</div>
<div class="cards">
 <div class="card crit"><div class="v">{n_crit}</div><div>critical</div></div>
 <div class="card warn"><div class="v">{n_warn}</div><div>warning</div></div>
 <div class="card"><div class="v">{n_rec}</div><div>recursive</div></div>
 <div class="card"><div class="v">{len(rows)}</div><div>functions</div></div>
</div>
<input id="filter" type="text" placeholder="Filter by function or file…" />
<span id="count"></span>
<table id="report">
<thead><tr>
<th class="sortable" data-type="text">Function<span class="arrow"></span></th>
<th class="sortable" data-type="num">Frame<span class="arrow"></span></th>
<th class="sortable sorted-desc" data-type="num">Peak<span class="arrow"></span></th>
<th class="sortable" data-type="num">Depth<span class="arrow"></span></th>
<th class="sortable" data-type="num">Severity<span class="arrow"></span></th>
<th class="sortable" data-type="text">Location<span class="arrow"></span></th>
<th class="sortable" data-type="num">Roots (depth)<span class="arrow"></span></th>
</tr></thead>
<tbody>
{chr(10).join(tr)}
</tbody></table>
<p class="meta">Peak is downward-only (frame + heaviest callee chain), root-independent.
A trailing &ldquo;+&rdquo; marks a lower bound due to recursion. Not tool-qualified;
for DO-178C Level A use a qualified analyzer (e.g. AbsInt StackAnalyzer).</p>
<script>
(function() {{
  var table = document.getElementById("report");
  var tbody = table.querySelector("tbody");
  var headers = Array.prototype.slice.call(table.querySelectorAll("th.sortable"));
  var filter = document.getElementById("filter");
  var countEl = document.getElementById("count");

  function rows() {{ return Array.prototype.slice.call(tbody.querySelectorAll("tr")); }}

  function sortBy(colIndex, type, asc) {{
    var rs = rows();
    rs.sort(function(a, b) {{
      var av = a.children[colIndex].getAttribute("data-sort");
      var bv = b.children[colIndex].getAttribute("data-sort");
      var cmp;
      if (type === "num") {{ cmp = parseFloat(av) - parseFloat(bv); }}
      else {{ cmp = av.localeCompare(bv); }}
      return asc ? cmp : -cmp;
    }});
    rs.forEach(function(r) {{ tbody.appendChild(r); }});
  }}

  headers.forEach(function(th, idx) {{
    th.addEventListener("click", function() {{
      var wasAsc = th.classList.contains("sorted-asc");
      var asc = !wasAsc;
      headers.forEach(function(h) {{ h.classList.remove("sorted-asc", "sorted-desc"); }});
      th.classList.add(asc ? "sorted-asc" : "sorted-desc");
      sortBy(idx, th.getAttribute("data-type"), asc);
    }});
  }});

  function applyFilter() {{
    var q = filter.value.toLowerCase();
    var shown = 0, total = 0;
    rows().forEach(function(r) {{
      total++;
      var fn = r.children[0].getAttribute("data-sort").toLowerCase();
      var loc = r.children[5].getAttribute("data-sort").toLowerCase();
      var match = !q || fn.indexOf(q) !== -1 || loc.indexOf(q) !== -1;
      r.classList.toggle("hidden", !match);
      if (match) shown++;
    }});
    countEl.textContent = q ? (shown + " / " + total + " shown") : "";
  }}
  filter.addEventListener("input", applyFilter);

  // Default: already sorted desc by Peak (server-side); reflect arrow only.
}})();
</script>
</body></html>"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)
