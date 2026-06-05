// src/fpTemplate.ts
// Pure builder for the "Generate fp-overrides template" command, factored out
// of extension.ts so it can be unit-tested without the VS Code runtime.

import * as path from "path";
import { DepthInfo, FunctionRecord } from "./callGraph";

export interface FpTemplateEntry {
  _hint: string;
  caller: string;
  file: string;
  via?: string;
  targets: string[];
}

export interface FpTemplateResult {
  /** Skeleton entries, one per unresolved (not-yet-overridden) fp call site. */
  entries: FpTemplateEntry[];
  /** How many sites were skipped because an override already covers them. */
  covered: number;
}

/** Build the fp-overrides template from the analysis state. One entry per fp
 *  call site that is NOT already covered by an override. `targets` is pre-filled
 *  with the auto-resolved candidates (including assignment-derived suggestions),
 *  so the user narrows rather than writes from scratch. Deterministic order
 *  (by caller, then via). */
export function buildFpTemplate(
  depth: Map<string, DepthInfo>,
  byName: Map<string, FunctionRecord>
): FpTemplateResult {
  const entries: FpTemplateEntry[] = [];
  let covered = 0;
  for (const [name, info] of depth) {
    const sites = info.fpSites;
    if (!sites || sites.length === 0) continue;
    const rec = byName.get(name);
    const file = rec ? path.basename(rec.file) : "";
    for (const s of sites) {
      if (s.overridden) { covered++; continue; }
      const isParam = typeof s.viaParam === "number" && s.viaParam >= 0;
      let hint: string;
      if (isParam) {
        hint = s.candidates.length
          ? "parameter callback — targets SUGGESTED from what callers pass (verify these are complete)"
          : "parameter callback — no callers found passing a function here; add the real target(s)";
      } else {
        hint = s.candidates.length
          ? "auto-resolved candidates below (over-approximated); narrow to the real targets"
          : "analyzer could not resolve this call site; add the real target(s)";
      }
      // The match key is caller + via (the fp variable/table name), which is
      // stable across edits. If a site has no `via`, caller alone disambiguates
      // — fine when the caller has a single fp site, otherwise note it so the
      // user can split the targets per site if needed.
      let matchHint = hint;
      if (!s.via) {
        const siteCount = sites.filter(x => !x.overridden).length;
        if (siteCount > 1) {
          matchHint += " — NOTE: this caller has multiple fp sites and this one " +
            "has no via name, so an override here would apply to all of them; " +
            "list the union of real targets, or add a distinguishing via.";
        }
      }
      const entry: FpTemplateEntry = {
        _hint: matchHint,
        caller: name,
        file,
        targets: s.candidates.slice()
      };
      if (s.via) entry.via = s.via;
      entries.push(entry);
    }
  }
  // Deterministic order: by caller, then by via (the stable match key).
  entries.sort((a, b) =>
    a.caller === b.caller
      ? (a.via || "").localeCompare(b.via || "")
      : a.caller.localeCompare(b.caller));
  return { entries, covered };
}

export const FP_TEMPLATE_COMMENT =
  "fp-overrides template generated from the current analysis. For each call site, " +
  "edit `targets` to the real function(s); remove entries you don't need. " +
  "Match key: `caller` is required and `via` (the fp variable/table name) identifies " +
  "the call site; this pair is stable across source edits (no line numbers). " +
  "`targets` REPLACES the auto-resolved candidates and marks the site verified. " +
  "For context-dependent targets use `conditional`: " +
  "[{ \"when\": { \"fromRoot\": \"...\" } | { \"callerContains\": \"...\" } | { \"all|any\": [...] } | { \"not\": ... }, \"targets\": [...] }]. " +
  "Set cCallDepth.fpOverridesPath to this file (or save it as <workspace>/fp-overrides.json).";

/** Serialize the template (comment + overrides) to the JSON text shown/saved. */
export function fpTemplateToJson(result: FpTemplateResult): string {
  return JSON.stringify({ _comment: FP_TEMPLATE_COMMENT, overrides: result.entries }, null, 2);
}
