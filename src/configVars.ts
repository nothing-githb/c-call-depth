// src/configVars.ts
//
// VS Code-style ${...} variable substitution for path settings, so a value can
// reference the workspace, the environment, the user's home, or ANOTHER setting:
//   ${workspaceFolder}        first workspace folder's absolute path
//   ${workspaceFolder:Name}   a named multi-root folder's path
//   ${userHome}               the user's home directory
//   ${pathSeparator} / ${/}   the OS path separator
//   ${env:NAME}               an environment variable
//   ${config:section.key}     the value of another configuration setting
//
// Kept dependency-free (no `vscode` import) so it is unit-testable; the extension
// builds the context from the live VS Code API.

export interface VarContext {
  /** workspace folders in order; [0] is the default `${workspaceFolder}` */
  workspaceFolders: { name: string; fsPath: string }[];
  /** environment variables (process.env) */
  env: Record<string, string | undefined>;
  /** user home directory (os.homedir()) */
  home: string;
  /** OS path separator (path.sep) */
  pathSep: string;
  /** look up another configuration value by dotted id, e.g. "cmake.buildDirectory" */
  getConfig: (id: string) => unknown;
}

/** Expand ${...} variables in `value` using `ctx`. Unknown variables are left
 *  untouched (so a literal "${foo}" survives rather than becoming ""). */
export function expandConfigVars(value: string, ctx: VarContext): string {
  if (!value || value.indexOf("${") < 0) return value;
  return value.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    if (expr === "workspaceFolder") return ctx.workspaceFolders[0]?.fsPath ?? whole;
    if (expr === "userHome") return ctx.home;
    if (expr === "pathSeparator" || expr === "/") return ctx.pathSep;
    let m: RegExpExecArray | null;
    if ((m = /^workspaceFolder:(.+)$/.exec(expr))) {
      const f = ctx.workspaceFolders.find(w => w.name === m![1]);
      return f ? f.fsPath : whole;
    }
    if ((m = /^env:(.+)$/.exec(expr))) {
      const v = ctx.env[m[1]];
      return v == null ? "" : String(v);
    }
    if ((m = /^config:(.+)$/.exec(expr))) {
      const v = ctx.getConfig(m[1]);
      // null/undefined → leave the token so it's visibly unresolved, not "".
      return v == null ? whole : String(v);
    }
    return whole; // unknown variable: leave as-is
  });
}
