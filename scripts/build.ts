/* eslint-disable no-console */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const env: NodeJS.ProcessEnv = { ...process.env };

if (isWindows && !env.CARGO_TARGET_DIR) {
  env.CARGO_TARGET_DIR = "C:/dev/clack-target";
}

const userArgs: string[] = process.argv.slice(2);
const hasBundleOverride = userArgs.some((arg) => arg === "-b" || arg === "--bundles");
const noBundle = userArgs.includes("--no-bundle");
const makeSimpleMacDmg = isMac && !hasBundleOverride && !noBundle;
const tauriArgs: string[] = ["tauri", "build", ...userArgs];

function readTarget(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-t" || arg === "--target") return args[i + 1] ?? "";
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
  }
  return "";
}

if (makeSimpleMacDmg) {
  tauriArgs.push("--bundles", "app");
  const target = readTarget(userArgs);
  if (target === "universal-apple-darwin") env.CLACK_DMG_ARCH = "universal";
}

// .ts を子プロセスで実行するときも type stripping + ExperimentalWarning 抑制を引き継ぐ。
const NODE_TS_ARGS = ["--no-warnings=ExperimentalWarning", "--experimental-strip-types"];

function run(command: string, args: string[]): void {
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

/** src/ 配下の HTML / CSS を再帰的に frontend-dist/ にコピーする。
 *  tsc が .ts → .js を生成 (rootDir 構造を保持)、こちらは静的アセットを
 *  同じディレクトリ構造で並べる役割。Tauri の frontendDist が
 *  frontend-dist/ を直接配信するので、両者を同じ階層に揃える必要がある。
 *  サブディレクトリ (styles/, windows/, etc.) も再帰的に走査する。 */
function syncStaticAssets(): void {
  const srcDir = path.join(projectRoot, "src");
  const outDir = path.join(projectRoot, "frontend-dist");
  fs.mkdirSync(outDir, { recursive: true });
  let copied = 0;
  function walk(rel: string): void {
    for (const name of fs.readdirSync(path.join(srcDir, rel))) {
      const relPath = rel ? path.join(rel, name) : name;
      const full = path.join(srcDir, relPath);
      if (fs.statSync(full).isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!/\.(html|css)$/i.test(name)) continue;
      const to = path.join(outDir, relPath);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(full, to);
      copied++;
    }
  }
  walk("");
  console.log(`Synced ${copied} static asset${copied === 1 ? "" : "s"} → frontend-dist/`);
}

// TypeScript ソース (src/*.ts) を tsc で frontend-dist/*.js にコンパイル。
// noEmitOnError: true なので型エラーがあれば exit 1 でビルドが止まる。
run("npx", ["tsc", "-p", "tsconfig.json"]);
syncStaticAssets();
run("npx", ["tauri", "icon", "icons/icon-1024.png"]);
run("npx", tauriArgs);
if (makeSimpleMacDmg) run("node", [...NODE_TS_ARGS, "scripts/create-mac-dmg.ts"]);
run("node", [...NODE_TS_ARGS, "scripts/copy-artifacts.ts"]);
