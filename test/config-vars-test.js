// Unit tests for src/configVars.ts expandConfigVars() — the ${...} variable
// substitution used by path settings (so a setting can reference the workspace,
// the environment, the user's home, or ANOTHER configuration value).
const { expandConfigVars } = require("../out/configVars.js");

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

const ctx = {
  workspaceFolders: [
    { name: "app", fsPath: "/home/u/app" },
    { name: "libs", fsPath: "/home/u/libs" },
  ],
  env: { BUILD: "/tmp/out", EMPTY: "" },
  home: "/home/u",
  pathSep: "/",
  getConfig: (id) => ({
    "cmake.buildDirectory": "/proj/build",
    "other.num": 42,
    "other.empty": "",
  })[id],   // undefined for unknown ids
};
const e = (s) => expandConfigVars(s, ctx);

check("no variables: returned unchanged", e("/abs/compile_commands.json") === "/abs/compile_commands.json");
check("${workspaceFolder}", e("${workspaceFolder}/build") === "/home/u/app/build");
check("${workspaceFolder:Name} (multi-root)", e("${workspaceFolder:libs}/cc.json") === "/home/u/libs/cc.json");
check("${workspaceFolder:Unknown} left as-is", e("${workspaceFolder:nope}/x") === "${workspaceFolder:nope}/x");
check("${userHome}", e("${userHome}/.cache") === "/home/u/.cache");
check("${pathSeparator} and ${/}", e("a${pathSeparator}b${/}c") === "a/b/c");
check("${env:NAME}", e("${env:BUILD}/compile_commands.json") === "/tmp/out/compile_commands.json");
check("${env:EMPTY} expands to empty string", e("[${env:EMPTY}]") === "[]");
check("${env:MISSING} expands to empty string", e("[${env:MISSING}]") === "[]");
check("${config:other.config} (the key feature)",
  e("${config:cmake.buildDirectory}/compile_commands.json") === "/proj/build/compile_commands.json");
check("${config:...} numeric value is stringified", e("${config:other.num}") === "42");
check("${config:other.empty} empty string", e("x${config:other.empty}y") === "xy");
check("${config:missing.key} left as-is (visibly unresolved, not blank)",
  e("${config:does.not.exist}/cc.json") === "${config:does.not.exist}/cc.json");
check("unknown ${foo} left as-is", e("${foo}/x") === "${foo}/x");
check("multiple variables in one value",
  e("${workspaceFolder}/${env:BUILD}".replace("${env:BUILD}", "${env:BUILD}")) === "/home/u/app//tmp/out");
check("empty input", e("") === "");

console.log(failed === 0
  ? "\nCONFIG-VARS: PASS — ${...} substitution works (workspace/env/home/config)."
  : `\nCONFIG-VARS: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
