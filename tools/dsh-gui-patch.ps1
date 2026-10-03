# DSH Desktop GUI draft-sync patcher.
# Injects dsh-phone draft sync into the DSH Desktop Electron app so the
# chat composer in the desktop window syncs drafts with the phone (and
# vice versa).
#
# Usage:  pwsh -File tools\dsh-gui-patch.ps1          (patch)
#         pwsh -File tools\dsh-gui-patch.ps1 -Revert  (restore original asar)
#
# Requirements:
#   - node.exe available on PATH (for tools\dsh-asar-pack.mjs)
#   - DSH Desktop must be CLOSED while patching (Windows locks app.asar)
#
# What it does:
#   1. backups app.asar -> app.asar.bak-original (first run) + timestamped
#   2. extracts app.asar into a temp dir (vendored @electron/asar)
#   3. merges files from the existing app.asar.unpacked back into the
#      extract tree (asar extract does not pull them in on windows)
#   4. injects draftsync-desktop.js into dsh-web-frontend/dist/index.html
#   5. repacks with tools\dsh-asar-pack.mjs, preserving the exact unpacked
#      set (native modules must stay outside the archive for require())
#   6. verifies the new archive entry-by-entry against the old one
#      (only index.html may differ) before deploying
#
# After a DSH Desktop self-update the patch is gone - just run this again.

param(
    [switch]$Revert
)

$ErrorActionPreference = "Stop"

# --- paths -------------------------------------------------------------------
$resourcesDir = Join-Path $env:LOCALAPPDATA "Programs\DSH Desktop\resources"
$asarPath = Join-Path $resourcesDir "app.asar"
$unpackedPath = Join-Path $resourcesDir "app.asar.unpacked"
$repoTools = $PSScriptRoot
$packer = Join-Path $repoTools "dsh-asar-pack.mjs"
$packerLib = Join-Path $repoTools "vendor\node_modules\@electron\asar\lib\asar.js"
if (-not (Test-Path $asarPath)) {
    Write-Host "app.asar not found at: $asarPath" -ForegroundColor Red
    Write-Host "Edit `$resourcesDir in this script if DSH Desktop lives elsewhere."
    exit 1
}
if (-not (Test-Path $packer) -or -not (Test-Path $packerLib)) {
    Write-Host "Missing tools\dsh-asar-pack.mjs or tools\vendor - run from the repo." -ForegroundColor Red
    exit 1
}

# --- helpers -----------------------------------------------------------------
$Asar = {
    param($action, $asar, $arg2)
    node -e "const a=require('$(($packerLib -replace '\\','/'))'); a.$action(process.argv[1], process.argv[2]).then(r=>process.stdout.write(typeof r==='string'?r:JSON.stringify(r))).catch(e=>{console.error(e.message);process.exit(1)})" $asar $arg2
}

# --- revert mode --------------------------------------------------------------
if ($Revert) {
    $bak = Get-ChildItem "$asarPath.bak-*" -ErrorAction SilentlyContinue | Where-Object Name -notmatch "original" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $bak) { $bak = Get-Item "$asarPath.bak-original" -ErrorAction SilentlyContinue }
    if (-not $bak) {
        Write-Host "No backup found - nothing to revert." -ForegroundColor Yellow
        exit 0
    }
    if (Get-Process -Name "DSH Desktop" -ErrorAction SilentlyContinue) {
        Write-Host "Close DSH Desktop first (it locks app.asar)." -ForegroundColor Red
        exit 1
    }
    Copy-Item $bak.FullName $asarPath -Force
    Write-Host "Reverted to $($bak.Name)" -ForegroundColor Green
    exit 0
}

# --- dsh desktop must be closed ------------------------------------------------
if (Get-Process -Name "DSH Desktop" -ErrorAction SilentlyContinue) {
    Write-Host "DSH Desktop is running - close it completely, then re-run this script." -ForegroundColor Red
    exit 1
}

# --- script payload -------------------------------------------------------------
$scriptPath = Join-Path $repoTools "..\dsh-phone\gui\draftsync-desktop.js"
if (-not (Test-Path $scriptPath)) { $scriptPath = Join-Path $repoTools "draftsync-desktop.js" }
if (-not (Test-Path $scriptPath)) {
    Write-Host "draftsync-desktop.js not found" -ForegroundColor Red
    exit 1
}
$payload = [System.IO.File]::ReadAllText((Resolve-Path $scriptPath))

# --- backup ----------------------------------------------------------------------
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not (Test-Path "$asarPath.bak-original")) {
    Copy-Item $asarPath "$asarPath.bak-original"
    Write-Host "First run: original saved as app.asar.bak-original"
}
Copy-Item $asarPath "$asarPath.bak-$stamp"
Write-Host "Backup: app.asar.bak-$stamp"

# --- extract ----------------------------------------------------------------------
$work = Join-Path $env:TEMP "dsh-asar-patch-$stamp"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $work "src") | Out-Null

Write-Host "Extracting app.asar (takes a minute)..."
& $Asar "extractAll" $asarPath (Join-Path $work "src")
if ($LASTEXITCODE -ne 0) { Write-Host "asar extract failed" -ForegroundColor Red; exit 1 }

# --- merge unpacked files back into the tree -------------------------------------
# `asar extractAll` skips entries marked unpacked that only exist in
# app.asar.unpacked - copy them over so repacking sees the full set.
if (Test-Path $unpackedPath) {
    $copied = 0
    Get-ChildItem $unpackedPath -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($unpackedPath.Length + 1)
        $dst = Join-Path (Join-Path $work "src") $rel
        if (-not (Test-Path $dst)) {
            New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
            Copy-Item $_.FullName $dst -Force
            $copied++
        }
    }
    Write-Host "Merged $copied missing unpacked files into the tree"
}

# --- inject ------------------------------------------------------------------------
$indexPath = Join-Path $work "src\node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html"
if (-not (Test-Path $indexPath)) {
    Write-Host "index.html not found inside asar" -ForegroundColor Red
    exit 1
}
$html = [System.IO.File]::ReadAllText($indexPath)
$begin = "<!--BEGIN dsh-draft-sync-->"
$end = "<!--END dsh-draft-sync-->"
$b1 = $html.IndexOf($begin)
if ($b1 -ge 0) {
    $e1 = $html.IndexOf($end)
    if ($e1 -ge 0) { $html = $html.Remove($b1, $e1 + $end.Length - $b1) }
}
$block = "`r`n$begin`r`n<script>`r`n$payload`r`n</script>`r`n$end`r`n"
if ($html -match "</body>") {
    $html = $html -replace "</body>", "$block</body>"
} else {
    $html = $html + $block
}
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($indexPath, $html, $enc)
Write-Host "Injected draft-sync script into index.html ($((Get-Item $indexPath).Length) bytes)"

# --- repack -------------------------------------------------------------------------
Write-Host "Repacking app.asar..."
$packed = Join-Path $work "app.asar"
node $packer (Join-Path $work "src") $packed
if ($LASTEXITCODE -ne 0) { Write-Host "asar pack failed" -ForegroundColor Red; exit 1 }
$unpackedNew = "$packed.unpacked"
if (-not (Test-Path $unpackedNew)) {
    Write-Host "Packer produced no unpacked dir - aborting, original untouched." -ForegroundColor Red
    exit 1
}

# --- verify entry-by-entry ------------------------------------------------------------
$verify = node -e "
const a = require('$(($packerLib -replace '\\','/'))');
(async () => {
  const flat = async (f) => {
    const h = (await a.getRawHeader(f)).header;
    const out = {};
    (function w(node, pref) {
      for (const [k, v] of Object.entries(node.files || {})) {
        const p = pref ? pref + '/' + k : k;
        if (v.files) w(v, p); else out[p] = { size: v.size, unp: !!v.unpacked };
      }
    })(h, '');
    return out;
  };
  const fo = await flat(process.argv[1]);
  const fn = await flat(process.argv[2]);
  let bad = 0;
  for (const [p, v] of Object.entries(fn)) {
    const o = fo[p];
    if (!o) continue;
    if (v.unp !== o.unp) { console.log('UNPACK-DIFF ' + p); bad++; }
    if (!v.unp && v.size !== o.size && !p.endsWith('dsh-web-frontend/dist/index.html')) { console.log('SIZE-DIFF ' + p + ' ' + o.size + ' -> ' + v.size); bad++; }
  }
  const missing = Object.keys(fo).filter((p) => !fn[p] && !p.endsWith('bundled-connector/uv.lock'));
  if (missing.length) { console.log('MISSING ' + missing.join(',')); bad += missing.length; }
  console.log(bad === 0 ? 'VERIFY-OK' : 'VERIFY-FAILED ' + bad);
})();" $asarPath $packed
Write-Host "Verify: $verify"
if ($verify -notmatch "VERIFY-OK") {
    Write-Host "Verification failed - aborting, original untouched." -ForegroundColor Red
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# --- unpacked set must match the original 1:1 -------------------------------------------
$origFiles = @(Get-ChildItem $unpackedPath -Recurse -File | ForEach-Object { $_.FullName.Substring($unpackedPath.Length + 1) })
$newFiles = @(Get-ChildItem $unpackedNew -Recurse -File | ForEach-Object { $_.FullName.Substring($unpackedNew.Length + 1) })
$setDiff = @(Compare-Object ($origFiles | Sort-Object) ($newFiles | Sort-Object))
if ($setDiff.Count -gt 0) {
    Write-Host "Unpacked file set mismatch ($($setDiff.Count) diffs) - aborting." -ForegroundColor Red
    $setDiff | Select-Object -First 8 | ForEach-Object { Write-Host "  $($_.SideIndicator) $($_.InputObject)" }
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "Unpacked set matches the original ($($origFiles.Count) files)"

# --- deploy -------------------------------------------------------------------------------
Copy-Item $packed $asarPath -Force
Write-Host "Deployed patched app.asar ($([math]::Round((Get-Item $asarPath).Length / 1MB, 1)) MB)" -ForegroundColor Green

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Start DSH Desktop - the composer now syncs drafts with dsh-phone." -ForegroundColor Green
Write-Host "Requirements: dsh-phone.exe running (it serves the sync on 127.0.0.1:8460)."
Write-Host "Devtools console (Ctrl+Shift+I) shows [dsh-draft-sync] lines when linked."
Write-Host "DSH Desktop updates wipe the patch - re-run this script afterwards."
