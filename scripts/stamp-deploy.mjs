#!/usr/bin/env node
// Stamps a build id into public/app.js for the duration of a deploy, then puts
// the file back exactly as it was, so the working tree is never left modified.
//
//   npm run deploy              stamp -> wrangler deploy -> restore
//   npm run deploy -- --dry-run print the id and stamped line, change nothing
//
// The id lives inside app.js on purpose: app.js is the file that goes stale in
// a browser cache, so the id the page reports must be the id of the bytes it is
// actually running. A separate version file could be fresh while app.js is old.
//
// Format: <YYMMDD>.<short sha>[+dirty], e.g. 260910.a1b2c3d
// "+dirty" means the deploy includes uncommitted changes, so the sha alone
// would not identify the code. Outside a git checkout it falls back to a date.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const APP_JS = new URL("../public/app.js", import.meta.url);
const DECLARATION = /const APP_VERSION = "[^"]*";/;

function git(args) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

function buildId() {
  const now = new Date();
  const day = [
    String(now.getFullYear()).slice(2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const sha = git(["rev-parse", "--short", "HEAD"]);
  if (!sha) return `${day}.local`;
  // only tracked-file edits mark the build dirty; untracked scratch files (editor
  // state, tooling dirs) are not part of the deploy and would mark it forever
  const edits = git(["status", "--porcelain", "--untracked-files=no"]);
  return `${day}.${sha}${edits ? "+dirty" : ""}`;
}

const id = buildId();
const original = readFileSync(APP_JS, "utf8");
if (!DECLARATION.test(original)) {
  console.error('stamp-deploy: no `const APP_VERSION = "...";` line found in public/app.js');
  process.exit(1);
}
const stamped = original.replace(DECLARATION, `const APP_VERSION = "${id}";`);

if (process.argv.includes("--dry-run")) {
  console.log(`build id:    ${id}`);
  console.log(`would write: ${stamped.match(DECLARATION)[0]}`);
  process.exit(0);
}

writeFileSync(APP_JS, stamped);
console.log(`stamp-deploy: deploying ${id}`);
try {
  const res = spawnSync(process.env.STAMP_DEPLOY_CMD || "npx wrangler deploy", {
    stdio: "inherit",
    shell: true,
  });
  process.exitCode = res.status ?? 1;
} finally {
  // always restore, including when the deploy fails or is interrupted
  writeFileSync(APP_JS, original);
  console.log("stamp-deploy: restored public/app.js");
}
