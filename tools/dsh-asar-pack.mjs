#!/usr/bin/env node
// Repack the extracted DSH Desktop asar tree, preserving the exact set of
// files electron-builder originally kept outside the archive
// (app.asar.unpacked): native binaries (sharp, koffi, ripgrep, node-pty),
// the pnpm runner, the bundled python connector and the tray pngs.
//
// Uses the vendored @electron/asar copy under tools/vendor (patched to
// normalize windows backslash paths for minimatch; upstream matches on
// forward slashes only, which silently drops every unpack rule on win32).
//
// usage: node tools/dsh-asar-pack.mjs <srcDir> <destAsar>
import { createPackageWithOptions } from "./vendor/node_modules/@electron/asar/lib/asar.js";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = process.argv[2];
const dest = process.argv[3];
if (!src || !dest) {
  console.error("usage: node tools/dsh-asar-pack.mjs <srcDir> <destAsar>");
  process.exit(1);
}

// minimatch sees absolute windows paths as forward-slash segment lists with
// a drive-letter head ("C:/..."), so every alternative needs a leading **/.
// Trailing "{**,*}" instead of plain "**": minimatch v10 only matches
// directories (not direct children) with a lone trailing **.
const UNPACK_GLOB = "{"
  + "**/node_modules/{"
  + "@agents-anywhere/dsh-bridge-next/lib/bundled-connector,"
  + "@img/sharp-win32-arm64,@img/sharp-win32-x64,"
  + "@koromix/koffi-win32-arm64,@koromix/koffi-win32-x64,"
  + "@vscode/ripgrep-win32-arm64,@vscode/ripgrep-win32-x64,"
  + "node-pty,pnpm,"
  + "node-addon-require-builtin-win32-arm64-msvc,"
  + "node-addon-require-builtin-win32-x64-msvc"
  + "}/{**,*},"
  + "**/build/{app-icon.png,tray-icon-blue.png,tray-icon-blue@1.25x.png,tray-icon-blue@1.5x.png,tray-icon-blue@2x.png}"
  + "}";

async function main() {
  await createPackageWithOptions(src, dest, { unpack: UNPACK_GLOB });
  console.log("packed " + dest);

  const unpackedRoot = dest + ".unpacked";
  try {
    statSync(unpackedRoot);
  } catch {
    console.log("no unpacked dir produced - unpack glob matched nothing");
    process.exit(1);
  }
  const files = [];
  (function walk(dir, prefix) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else files.push(rel);
    }
  })(unpackedRoot, "");
  console.log("unpacked files: " + files.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
