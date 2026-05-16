/* eslint-disable no-console */
/**
 * Copy Tauri build artifacts back into the project tree (./dist) so the
 * user doesn't have to dig into target/.
 *
 * Cross-platform:
 *   - Windows: copies clack.exe + WebView2Loader.dll + NSIS / MSI installers
 *   - macOS:   copies .dmg (and the universal app bundle as a tarball if present)
 *   - Linux:   copies .deb / .AppImage if present (lightweight support)
 *
 * Source target-dir:
 *   - On Windows, scripts/build.js sets CARGO_TARGET_DIR to an ASCII path
 *     (C:/dev/clack-target) to work around MinGW non-ASCII path issues.
 *   - On macOS / Linux, we fall back to the cargo default `src-tauri/target`.
 *   - `CARGO_TARGET_DIR` env var (if set) wins over both.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function resolveTargetDir() {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  if (isWindows) return "C:/dev/clack-target";
  // Default Cargo target-dir.
  return path.join(projectRoot, "src-tauri", "target");
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  ${path.relative(projectRoot, dest)}`);
  return true;
}

function copyGlob(srcDir, destDir, predicate) {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(srcDir)) {
    if (!predicate(name)) continue;
    if (copyIfExists(path.join(srcDir, name), path.join(destDir, name))) count++;
  }
  return count;
}

function main() {
  const targetDir = resolveTargetDir();
  const releaseDir = path.join(targetDir, "release");

  if (!fs.existsSync(releaseDir)) {
    console.error(
      `No build output at ${releaseDir}. Run \`npm run build\` first.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(distDir, { recursive: true });
  console.log(`Copying artifacts into ${path.relative(projectRoot, distDir) || "."}/`);

  let copied = 0;

  if (isWindows) {
    // Stand-alone executable + WebView2 loader.
    if (copyIfExists(path.join(releaseDir, "clack.exe"), path.join(distDir, "clack.exe"))) copied++;
    if (copyIfExists(
      path.join(releaseDir, "WebView2Loader.dll"),
      path.join(distDir, "WebView2Loader.dll"),
    )) copied++;
    // Bundled installers.
    copied += copyGlob(
      path.join(releaseDir, "bundle", "nsis"),
      distDir,
      (n) => n.toLowerCase().endsWith(".exe"),
    );
    copied += copyGlob(
      path.join(releaseDir, "bundle", "msi"),
      distDir,
      (n) => n.toLowerCase().endsWith(".msi"),
    );
  } else if (isMac) {
    if (fs.existsSync(distDir)) {
      for (const name of fs.readdirSync(distDir)) {
        if (name.startsWith("rw.") && name.toLowerCase().endsWith(".dmg")) {
          fs.rmSync(path.join(distDir, name), { force: true });
        }
      }
    }
    // DMG: the user-facing distribution format.
    copied += copyGlob(
      path.join(releaseDir, "bundle", "dmg"),
      distDir,
      (n) => n.toLowerCase().endsWith(".dmg") && !n.startsWith("rw."),
    );
    // Note: the .app bundle itself is a directory; not worth copying into
    // dist/ since users normally drag it from the .dmg.
  } else {
    // Linux best-effort.
    copied += copyGlob(
      path.join(releaseDir, "bundle", "deb"),
      distDir,
      (n) => n.toLowerCase().endsWith(".deb"),
    );
    copied += copyGlob(
      path.join(releaseDir, "bundle", "appimage"),
      distDir,
      (n) => n.toLowerCase().endsWith(".appimage"),
    );
  }

  if (copied === 0) {
    console.error(`No artifacts found to copy on ${os.platform()}.`);
    process.exit(1);
  }
  console.log(`Done (${copied} file${copied === 1 ? "" : "s"}).`);
}

main();
