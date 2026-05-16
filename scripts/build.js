/* eslint-disable no-console */
"use strict";

const { spawnSync } = require("child_process");

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const env = { ...process.env };

if (isWindows && !env.CARGO_TARGET_DIR) {
  env.CARGO_TARGET_DIR = "C:/dev/clack-target";
}

const userArgs = process.argv.slice(2);
const hasBundleOverride = userArgs.some((arg) => arg === "-b" || arg === "--bundles");
const noBundle = userArgs.includes("--no-bundle");
const makeSimpleMacDmg = isMac && !hasBundleOverride && !noBundle;
const tauriArgs = ["tauri", "build", ...userArgs];

function readTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-t" || arg === "--target") return args[i + 1];
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
  }
  return "";
}

if (makeSimpleMacDmg) {
  tauriArgs.push("--bundles", "app");
  const target = readTarget(userArgs);
  if (target === "universal-apple-darwin") env.CLACK_DMG_ARCH = "universal";
}

function run(command, args) {
  const result = spawnSync(command, args, {
    env,
    shell: isWindows,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npx", ["tauri", "icon", "icons/icon-1024.png"]);
run("npx", tauriArgs);
if (makeSimpleMacDmg) run("node", ["scripts/create-mac-dmg.js"]);
run("node", ["scripts/copy-artifacts.js"]);
