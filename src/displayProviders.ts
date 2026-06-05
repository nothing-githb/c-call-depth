// src/displayProviders.ts
// Renders the call-depth/stack annotations next to C functions.
// Two visual modes:
//   - "decoration": colored pill at end of the function-name line
//   - "hover":      MarkdownString shown on cursor hover over the name
// In both modes the hover content is identical — decorations expose it
// through TextEditorDecorationType.hoverMessage, hovers through HoverProvider.

import * as vscode from "vscode";
import * as path from "path";
import { FunctionRecord, DepthInfo, CallPath, PerRootAnalysis, pathsFrom, pathsTo } from "./callGraph";

/** Normalize a filesystem path for map keys/lookups so the same file matches
 *  regardless of separator style (\ vs /) or drive-letter case on Windows.
 *  Exported so the extension builds byFile with the SAME normalization the
 *  decoration/hover lookups use — otherwise a path mismatch silently yields no
 *  decorations/hover. */
export function normPath(p: string): string {
  if (!p) return p;
  let n = p.replace(/\\/g, "/");
  // On Windows, drive letters and the whole path are case-insensitive.
  if (process.platform === "win32") n = n.toLowerCase();
  return n;
}

export interface DisplayConfig {
  mode: "decoration" | "hover";
  /** stack bytes ≤ warn = green, ≤ critical = amber, otherwise red */
  thresholdWarn: number;
  thresholdCritical: number;
  /** max paths shown in hover for each direction */
  pathsLimit: number;
  /** depth cap for path enumeration */
  pathsMaxDepth: number;
}

export interface DisplayState {
  byName: Map<string, FunctionRecord>;
  byFile: Map<string, FunctionRecord[]>;
  depth: Map<string, DepthInfo>;
  pinnedRoots?: ReadonlySet<string>;
}

// ---------- decoration mode ----------

interface SeverityDecorations {
  ok: vscode.TextEditorDecorationType;
  warn: vscode.TextEditorDecorationType;
  critical: vscode.TextEditorDecorationType;
  unknown: vscode.TextEditorDecorationType;
}

let decTypes: SeverityDecorations | undefined;

export function createDecorationTypes(): SeverityDecorations {
  // After-line pills. We use 'after' content via decorationType so the text
  // is virtual (not in the buffer). Colors come from semantic theme colors
  // so they adapt to light/dark.
  const make = (bg: string, fg: string): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 1.5rem",
        backgroundColor: bg,
        color: fg,
        // Subtle border so the pill stands away from the code on busy backgrounds.
        border: "1px solid " + bg,
        // Padded via inline margins in content; VS Code's `after` doesn't
        // expose padding directly. Spaces around the text in contentText
        // produce horizontal padding visually.
        fontWeight: "normal"
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
  return {
    // Foreground first, then background — using web-safe semi-transparent fills
    // so the underlying line bg shows through subtly.
    ok: make("rgba( 38, 139,  46, 0.18)", "#1d6e2d"),
    warn: make("rgba(186, 117,  23, 0.20)", "#854f0b"),
    critical: make("rgba(226,  75,  74, 0.22)", "#a32d2d"),
    unknown: make("rgba(128, 128, 128, 0.18)", "#5f5e5a")
  };
}

export function disposeDecorationTypes() {
  if (!decTypes) return;
  decTypes.ok.dispose();
  decTypes.warn.dispose();
  decTypes.critical.dispose();
  decTypes.unknown.dispose();
  decTypes = undefined;
}

function pickSeverity(
  stack: number | undefined,
  cfg: DisplayConfig
): "ok" | "warn" | "critical" | "unknown" {
  if (stack === undefined) return "unknown";
  if (stack <= cfg.thresholdWarn) return "ok";
  if (stack <= cfg.thresholdCritical) return "warn";
  return "critical";
}

/** Apply decorations to one editor. Caller is responsible for tracking
 *  which editors are active. */
export function applyDecorations(
  editor: vscode.TextEditor,
  state: DisplayState,
  cfg: DisplayConfig
) {
  if (cfg.mode !== "decoration") {
    // Clear any previously applied decorations for this editor.
    if (decTypes) {
      editor.setDecorations(decTypes.ok, []);
      editor.setDecorations(decTypes.warn, []);
      editor.setDecorations(decTypes.critical, []);
      editor.setDecorations(decTypes.unknown, []);
    }
    return;
  }
  if (!decTypes) decTypes = createDecorationTypes();

  const recs = state.byFile.get(normPath(editor.document.uri.fsPath));
  if (!recs) return;

  const buckets: Record<"ok" | "warn" | "critical" | "unknown", vscode.DecorationOptions[]> = {
    ok: [],
    warn: [],
    critical: [],
    unknown: []
  };

  // For each function, emit one decoration per perRoot entry. Multiple
  // pills sit side-by-side on the same line, separated by a small gap.
  // Severity is computed per-entry from that entry's cumulativeStack —
  // currently identical across entries (forward-graph dependent only),
  // but kept per-entry so future per-root cum analysis just slots in.
  for (const rec of recs) {
    const info = state.depth.get(rec.name);
    if (!info) continue;
    const line = editor.document.lineAt(rec.nameLine);
    const range = new vscode.Range(line.range.end, line.range.end);

    // Build a single combined "after" string with all pills, severity
    // taken from the highest-peak entry (first in sorted perRoot).
    // We render the whole combined string in a single decoration so VS Code
    // doesn't reorder or stack them unpredictably; severity color tracks
    // the worst entry, since that's the one that matters for safety.
    const entries = info.perRoot.length > 0 ? info.perRoot : [{
      rootName: "(auto)",
      depth: info.depth,
      cumulativeStack: info.cumulativeStack,
      cumulativeBounded: info.cumulativeBounded
    }];
    // Show only the worst (first, highest-peak) root inline to keep the line
    // uncluttered; if the function is reachable from more roots, append a
    // compact "+N" badge. The full per-root list lives in the hover/panel.
    const worst = entries[0];
    const hasUnbound = Array.isArray(info.fpSites) && info.fpSites.some(s => s.overridden !== true);
    // Root status is the function's OWN authoritative flag (matches the side
    // panel), not "is the worst root pinned". This keeps the 📌/⚓ marker
    // consistent between the pill, the hover, and the panel.
    // Peak shown is the function's OWN downward peak (info.cumulativeStack) —
    // the same value as the side panel's top-card "Peak" — NOT a per-root
    // entry-inclusive figure.
    let combined = formatPillText(rec, worst, info.recursive,
      { isPinnedRoot: info.isPinnedRoot === true, isAutoRoot: info.isAutoRoot === true },
      { verified: info.fpVerified === true, hasUnbound },
      { peak: info.cumulativeStack, peakBounded: info.cumulativeBounded === true });
    if (entries.length > 1) {
      combined += " +" + (entries.length - 1);
    }
    // Severity from the function's own downward peak (matches the panel).
    const sev = pickSeverity(info.cumulativeStack, cfg);

    const hover = buildHoverMarkdown(rec, info, state, cfg);
    buckets[sev].push({
      range,
      hoverMessage: hover,
      renderOptions: {
        after: { contentText: "  " + combined + "  " }
      }
    });
  }

  editor.setDecorations(decTypes.ok, buckets.ok);
  editor.setDecorations(decTypes.warn, buckets.warn);
  editor.setDecorations(decTypes.critical, buckets.critical);
  editor.setDecorations(decTypes.unknown, buckets.unknown);
}

function formatPillText(
  rec: FunctionRecord,
  entry: PerRootAnalysis,
  recursive: boolean,
  rootStatus: { isPinnedRoot?: boolean; isAutoRoot?: boolean },
  fpInfo?: { verified?: boolean; hasUnbound?: boolean },
  ownPeak?: { peak?: number; peakBounded?: boolean }
): string {
  const parts: string[] = [];
  // Root marker reflects the function's OWN status (authoritative, matches the
  // side panel & hover): 📌 pinned root, ⚓ auto root, (none) if interior.
  if (rootStatus.isPinnedRoot) {
    parts.push("📌");
  } else if (rootStatus.isAutoRoot) {
    parts.push("⚓");
  }
  // Function-pointer marker:
  //   ≀✓  all fp sites manually bound (verified, exact)
  //   ≀~  has fp call(s) but NOT bound — estimated (worst-case over-approx)
  //   ≀   (fallback) has indirect calls, binding state unknown
  if (rec.indirectCallees && rec.indirectCallees.length > 0) {
    if (fpInfo?.hasUnbound) parts.push("≀~");
    else if (fpInfo?.verified) parts.push("≀✓");
    else parts.push("≀");
  } else if (fpInfo?.hasUnbound) {
    // Unresolved fp site with no inferred targets (empty indirectCallees) —
    // still flag it, since it's an unbound estimate (possible under-approx).
    parts.push("≀~");
  }
  // Root tag (only when meaningful — skip for "(auto)").
  if (entry.rootName !== "(auto)") {
    parts.push(entry.rootName === "(unreached)" ? entry.rootName : `via ${entry.rootName}`);
  }
  // Recursion marker (kept — it's independent of depth). Depth itself is no
  // longer shown inline; the per-root depth lives in the side panel.
  if (recursive) {
    parts.push("↻");
  }
  if (rec.stackBytes !== undefined) {
    parts.push(`f:${formatBytes(rec.stackBytes)}`);
  } else {
    parts.push("f:?");
  }
  // Peak = the function's OWN downward peak (same as the side panel), not the
  // per-root entry-inclusive figure.
  const pk = ownPeak ? ownPeak.peak : entry.cumulativeStack;
  if (pk !== undefined && pk > 0) {
    const suffix = (ownPeak ? ownPeak.peakBounded : entry.cumulativeBounded) ? "+" : "";
    parts.push(`p:${formatBytes(pk)}${suffix}`);
  } else if (pk === undefined) {
    parts.push("p:?");
  }
  return "‹ " + parts.join(" · ") + " ›";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------- hover content (shared by decoration hoverMessage + HoverProvider) ----------

export function buildHoverMarkdown(
  rec: FunctionRecord,
  info: DepthInfo,
  state: DisplayState,
  cfg: DisplayConfig
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;

  // ── Header: name + flags ─────────────────────────────────────────────
  // Root status comes from the analyzer's authoritative flags (same source the
  // side panel uses), NOT a depth heuristic — so hover and panel always agree.
  md.appendMarkdown(`### \`${rec.name}\`\n\n`);
  const isPinned = info.isPinnedRoot === true;
  const isAutoRoot = info.isAutoRoot === true;
  const flags: string[] = [];
  if (info.recursive) flags.push("**recursive ↻**");
  if (isPinned) flags.push("**📌 pinned root**");
  else if (isAutoRoot) flags.push("**⚓ auto root** _(no callers in workspace)_");
  if (rec.ghost) flags.push("_ghost (no LSP record)_");
  if (flags.length > 0) {
    md.appendMarkdown(flags.join(" · ") + "\n\n");
  }
  // Quick actions: open in the side panel (full per-root breakdown) or the
  // interactive call graph.
  {
    const args = encodeURIComponent(JSON.stringify([rec.name]));
    md.appendMarkdown(
      `[⊞ open in side panel](command:cCallDepth.lookupInPanel?${args})` +
      ` &nbsp;·&nbsp; ` +
      `[⊹ view in call graph](command:cCallDepth.openGraph?${args})\n\n`
    );
  }

  // ── Key metrics ──────────────────────────────────────────────────────
  // If there's only one root entry, show it inline. If multiple, show a
  // per-root table — each row is one entry-point's view.
  const entries = info.perRoot.length > 0 ? info.perRoot : [{
    rootName: "(auto)",
    depth: info.depth,
    cumulativeStack: info.cumulativeStack,
    cumulativeBounded: info.cumulativeBounded
  }];

  if (rec.stackBytes !== undefined) {
    const q = rec.stackQualifier ? ` _(${rec.stackQualifier})_` : "";
    md.appendMarkdown(`**Own frame:** \`${formatBytes(rec.stackBytes)}\`${q}\n\n`);
  } else {
    md.appendMarkdown(`**Own frame:** _not in any .su file_\n\n`);
  }

  // Peak = the function's OWN downward peak (frame + heaviest callee chain),
  // entry-independent — the SAME value shown on the side panel's top card.
  // This is NOT a per-root entry-inclusive figure.
  if (info.cumulativeStack !== undefined) {
    const peak = formatBytes(info.cumulativeStack) + (info.cumulativeBounded ? "+" : "");
    const sev = describeSeverity(info.cumulativeStack, cfg);
    md.appendMarkdown(`**Peak:** \`${peak}\` ${sev}\n\n`);
  } else {
    md.appendMarkdown(`**Peak:** _not available_\n\n`);
  }

  // Supplementary per-root breakdown (entry-inclusive), shown when the function
  // is reached from more than one entry point — mirrors the side panel's table.
  if (entries.length > 1) {
    md.appendMarkdown(`**Per-root analysis** _(reachable from ${entries.length} entry points; peaks are entry-inclusive)_\n\n`);
    md.appendMarkdown(`| From root | Peak stack |\n|---|---|\n`);
    for (const e of entries) {
      const isPin = state.pinnedRoots?.has(e.rootName) === true;
      const isSpecial = e.rootName === "(auto)" || e.rootName === "(unreached)";
      const marker = isPin ? "📌 " : (e.isAuto && !isSpecial ? "⚓ " : "");
      const root = isSpecial
        ? `_${e.rootName}_`
        : `${marker}\`${e.rootName}\``;
      const peak = e.cumulativeStack !== undefined
        ? `\`${formatBytes(e.cumulativeStack)}${e.cumulativeBounded ? "+" : ""}\` ${describeSeverity(e.cumulativeStack, cfg)}`
        : "_n/a_";
      md.appendMarkdown(`| ${root} | ${peak} |\n`);
    }
    md.appendMarkdown(`\n`);
  }

  // ── Location ────────────────────────────────────────────────────────
  if (!rec.ghost) {
    const fileShort = rec.file.split(/[\\\/]/).slice(-2).join("/");
    md.appendMarkdown(`📍 \`${fileShort}\` line ${rec.nameLine + 1}\n\n`);
  }

  // ── Direct callees ──────────────────────────────────────────────────
  // Split into "in-graph" (we know about them) and "external" (libc, kernel
  // APIs, function pointers we couldn't resolve). The external set is
  // useful to surface because it explains why a peak might be lower than
  // expected (we don't account for libc stack usage).
  if (rec.callees.length > 0) {
    const inGraph: string[] = [];
    const external: string[] = [];
    for (const callee of rec.callees) {
      if (state.byName.has(callee)) inGraph.push(callee);
      else external.push(callee);
    }
    if (inGraph.length > 0) {
      md.appendMarkdown(`**Calls in workspace:** ` +
        inGraph.map(n => fnLink(n, state)).join(", ") + "\n\n");
    }
    if (external.length > 0) {
      const shown = external.slice(0, 10);
      const more = external.length > 10 ? ` _(+${external.length - 10} more)_` : "";
      md.appendMarkdown(`**External calls:** ` +
        shown.map(n => `\`${n}\``).join(", ") + `${more}\n\n` +
        `_External call stacks are not counted in the peak._\n\n`);
    }
  }

  // ── Function-pointer calls ──────────────────────────────────────────
  // Distinguish MANUALLY BOUND sites (from fp-overrides.json — exact) from
  // ESTIMATED sites (no override — auto over-approximated, NOT bound). When a
  // site has no resolvable candidates AND no override, it is unresolved and
  // contributes nothing to the stack estimate (possible UNDER-approximation).
  const fpSites = (info.fpSites && info.fpSites.length > 0) ? info.fpSites : undefined;
  if (fpSites) {
    md.appendMarkdown(`**≀ Function-pointer calls**\n\n`);
    for (const s of fpSites) {
      const viaTxt = s.via ? `\`${s.via}\`` : "(fp)";
      const loc = s.line ? ` _(line ${s.line})_` : "";
      if (s.overridden) {
        const tgts = s.candidates.length
          ? s.candidates.map(t => fnLink(t, state)).join(", ")
          : "_(none)_";
        md.appendMarkdown(`- ✓ ${viaTxt}${loc} — **bound** (verified via fp-overrides): ${tgts}\n`);
      } else if (s.candidates.length > 0) {
        const tgts = s.candidates.map(t => fnLink(t, state)).join(", ");
        md.appendMarkdown(`- ~ ${viaTxt}${loc} — **estimated, not bound** (worst-case over-approximation): ${tgts}\n`);
      } else {
        md.appendMarkdown(`- ⚠ ${viaTxt}${loc} — **unresolved, not bound** — no targets inferred; this call contributes nothing to the stack estimate (possible under-approximation). Add an fp-override.\n`);
      }
    }
    const anyUnbound = fpSites.some(s => !s.overridden);
    if (anyUnbound) {
      md.appendMarkdown(`\n_Unbound sites are auto-estimated, not manually verified. Use "Generate fp-overrides template" to bind them._\n\n`);
    } else {
      md.appendMarkdown(`\n`);
    }
  } else if (rec.indirectCallees && rec.indirectCallees.length > 0) {
    // Fallback (older data without fpSites): show the over-approximated set.
    md.appendMarkdown(`**≀ Indirect calls** _(via function pointers, estimated — not bound)_\n\n`);
    const targets = rec.indirectCallees.map(t => fnLink(t, state)).join(", ");
    md.appendMarkdown(`- possible targets: ${targets}\n`);
    md.appendMarkdown(`\n_Auto-resolved worst-case; not manually verified._\n\n`);
  }

  // ── Outgoing paths (top by stack) ───────────────────────────────────
  // ── Outgoing paths (top by stack) ───────────────────────────────────
  // We enumerate one over the visible limit so we can tell whether there
  // are more we're not showing — but we don't know the exact total beyond
  // that. The hover text adapts: silent when listing all, "showing N, more
  // exist" only when truncated. Singular vs plural is also fixed up.
  const out = pathsFrom(state.byName, rec.name, cfg.pathsLimit + 1, cfg.pathsMaxDepth);
  const nonTrivialOut = out.filter(p => p.nodes.length > 1);
  if (nonTrivialOut.length > 0) {
    const shown = Math.min(cfg.pathsLimit, nonTrivialOut.length);
    const truncated = nonTrivialOut.length > cfg.pathsLimit;
    const heading = shown === 1 ? "Outgoing path" : "Outgoing paths";
    const note = truncated ? ` _(showing top ${shown} by stack, more exist)_` : "";
    md.appendMarkdown(`**${heading}**${note}\n\n`);
    appendPathTable(md, nonTrivialOut.slice(0, cfg.pathsLimit), "from", state);
    if (truncated) {
      const args = encodeURIComponent(JSON.stringify([rec.name]));
      md.appendMarkdown(`\n[⤢ open all in side panel](command:cCallDepth.lookupInPanel?${args})\n`);
    }
    md.appendMarkdown(`\n`);
  }

  // ── Incoming paths (callers) ────────────────────────────────────────
  const inn = pathsTo(state.byName, rec.name, cfg.pathsLimit + 1, cfg.pathsMaxDepth, state.pinnedRoots);
  const nonTrivial = inn.filter(p => p.nodes.length > 1);
  if (nonTrivial.length > 0) {
    const shown = Math.min(cfg.pathsLimit, nonTrivial.length);
    const truncated = nonTrivial.length > cfg.pathsLimit;
    const heading = shown === 1 ? "Caller" : "Callers";
    const note = truncated ? ` _(showing top ${shown} by stack, more exist)_` : "";
    md.appendMarkdown(`**${heading}**${note}\n\n`);
    appendPathTable(md, nonTrivial.slice(0, cfg.pathsLimit), "to", state);
    if (truncated) {
      const args = encodeURIComponent(JSON.stringify([rec.name]));
      md.appendMarkdown(`\n[⤢ open all in side panel](command:cCallDepth.lookupInPanel?${args})\n`);
    }
  } else if (rec.callees.length === 0 && nonTrivialOut.length === 0) {
    // truly isolated function
    md.appendMarkdown(`_No callers or callees in workspace — leaf / unreachable._\n`);
  }

  return md;
}

/** Render a one-word severity classifier as a markdown badge. */
function describeSeverity(stackBytes: number, cfg: DisplayConfig): string {
  if (stackBytes <= cfg.thresholdWarn) {
    return `_below warn threshold (${formatBytes(cfg.thresholdWarn)})_`;
  }
  if (stackBytes <= cfg.thresholdCritical) {
    return `⚠ _over warn threshold (${formatBytes(cfg.thresholdWarn)})_`;
  }
  return `❗ _over critical threshold (${formatBytes(cfg.thresholdCritical)})_`;
}

/** Render a function name as a markdown link to the gotoFunction command.
 *  Falls back to plain code formatting if we don't have a non-ghost record
 *  for the name (otherwise the click would just show an error toast). */
function fnLink(name: string, state: DisplayState): string {
  const rec = state.byName.get(name);
  if (!rec || rec.ghost) return `\`${name}\``;
  // command: URIs require the trusted flag on the MarkdownString, which we
  // set at the top of buildHoverMarkdown. Arguments are JSON-encoded then
  // URI-encoded; VS Code parses them back.
  const args = encodeURIComponent(JSON.stringify([name]));
  return `[\`${name}\`](command:cCallDepth.gotoFunction?${args})`;
}

function appendPathTable(md: vscode.MarkdownString, paths: CallPath[], _kind: "from" | "to", state: DisplayState) {
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const arrow = " → ";
    const chain = p.nodes.map(n => fnLink(n, state)).join(arrow);
    const suffix = p.truncatedByCycle ? " _(↻ truncated)_" : "";
    md.appendMarkdown(`- ${chain} &nbsp; — \`${formatBytes(p.totalStack)}\`${suffix}\n`);
  }
}

// ---------- hover provider (used when mode === "hover") ----------

export function makeHoverProvider(
  getState: () => DisplayState,
  getConfig: () => DisplayConfig
): vscode.HoverProvider {
  return {
    provideHover(doc, position) {
      const cfg = getConfig();
      if (cfg.mode !== "hover") return undefined;
      const state = getState();
      const recs = state.byFile.get(normPath(doc.uri.fsPath));
      if (!recs) return undefined;
      // Find the function whose name token is under the cursor.
      const word = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (!word) return undefined;
      const ident = doc.getText(word);
      // Match by name AND line proximity — same identifier may appear inside
      // many function bodies as a call; we only want to fire on the definition.
      const matching = recs.find(r => r.name === ident && r.nameLine === position.line);
      if (!matching) return undefined;
      const info = state.depth.get(matching.name);
      if (!info) return undefined;
      const md = buildHoverMarkdown(matching, info, state, cfg);
      return new vscode.Hover(md, word);
    }
  };
}
