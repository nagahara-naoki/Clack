/* eslint-disable no-console */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
}

const projectRoot = path.resolve(__dirname, "..");
const packageJson: PackageJson = require(path.join(projectRoot, "package.json"));
const appName = "Clack";
const arch = process.env.CLACK_DMG_ARCH || (process.arch === "arm64" ? "aarch64" : process.arch);
const releaseDir = path.join(projectRoot, "src-tauri", "target", "release");
const appPath = path.join(releaseDir, "bundle", "macos", `${appName}.app`);
const dmgDir = path.join(releaseDir, "bundle", "dmg");
const dmgPath = path.join(dmgDir, `${appName}_${packageJson.version}_${arch}.dmg`);

if (process.platform !== "darwin") {
  console.error("create-mac-dmg.ts only runs on macOS.");
  process.exit(1);
}

if (!fs.existsSync(appPath)) {
  console.error(`Missing app bundle: ${appPath}`);
  process.exit(1);
}

fs.mkdirSync(dmgDir, { recursive: true });
for (const name of fs.readdirSync(dmgDir)) {
  if (name.startsWith("rw.") && name.endsWith(".dmg")) {
    fs.rmSync(path.join(dmgDir, name), { force: true });
  }
}

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "clack-dmg-"));
try {
  fs.cpSync(appPath, path.join(stagingDir, `${appName}.app`), { recursive: true });
  fs.symlinkSync("/Applications", path.join(stagingDir, "Applications"));

  const result = spawnSync(
    "hdiutil",
    ["create", dmgPath, "-volname", appName, "-srcfolder", stagingDir, "-ov", "-format", "UDZO"],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);

  console.log(`Created ${path.relative(projectRoot, dmgPath)}`);
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
