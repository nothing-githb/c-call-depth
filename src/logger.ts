// src/logger.ts
// Levelled logger over OutputChannel.
// Levels (most → least verbose): debug, info, warn, error.
// Each log line carries a level prefix and a category. The configured
// minimum level filters out anything below it.

import * as vscode from "vscode";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR"
};

export class Logger {
  private channel: vscode.OutputChannel;
  private startMs: number;
  private minLevel: LogLevel = "info";
  private repeatCounts = new Map<string, number>();

  constructor(channel: vscode.OutputChannel) {
    this.channel = channel;
    this.startMs = Date.now();
  }

  setLevel(level: LogLevel) {
    this.minLevel = level;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  /** Begin a phase. Returns a function to call when the phase ends.
   *  Phase headers always print at the configured level (info by default). */
  beginPhase(name: string, detail?: string): () => void {
    const t = Date.now();
    this.write("info", "phase", `▶ ${name}${detail ? " — " + detail : ""}`);
    return () => {
      const ms = Date.now() - t;
      this.write("info", "phase", `✓ ${name} (${this.fmtMs(ms)})`);
    };
  }

  debug(category: string, msg: string) { this.write("debug", category, msg); }
  info(category: string, msg: string)  { this.write("info",  category, msg); }
  warn(category: string, msg: string)  { this.write("warn",  category, `⚠ ${msg}`); }
  error(category: string, msg: string) { this.write("error", category, `✖ ${msg}`); }

  /** Log only the first N occurrences of a repeated message category, then
   *  summarize the rest with `flushRepeated`. Useful for per-file errors. */
  repeated(level: LogLevel, category: string, msg: string, cap: number = 3) {
    const n = (this.repeatCounts.get(category) ?? 0) + 1;
    this.repeatCounts.set(category, n);
    if (n <= cap) {
      this.write(level, category, msg);
    } else if (n === cap + 1) {
      this.write(level, category, `… (further ${category} messages suppressed)`);
    }
  }

  flushRepeated() {
    for (const [cat, count] of this.repeatCounts) {
      if (count > 0) {
        this.write("info", cat, `total ${cat} events: ${count}`);
      }
    }
    this.repeatCounts.clear();
  }

  /** Print a two-column summary box. Always at info level. */
  summary(title: string, rows: Array<[string, string | number]>) {
    if (!this.enabled("info")) return;
    this.channel.appendLine("");
    this.channel.appendLine(`── ${title} ─────`);
    const maxKey = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
    for (const [k, v] of rows) {
      this.channel.appendLine(`  ${k.padEnd(maxKey)}  ${v}`);
    }
    this.channel.appendLine("");
  }

  show(preserveFocus: boolean = true) {
    this.channel.show(preserveFocus);
  }

  private write(level: LogLevel, category: string, msg: string) {
    if (!this.enabled(level)) return;
    const sinceStart = Date.now() - this.startMs;
    const time = this.fmtMs(sinceStart);
    this.channel.appendLine(`[${time.padStart(7)}] ${LEVEL_PREFIX[level]} [${category}] ${msg}`);
  }

  private fmtMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }
}
