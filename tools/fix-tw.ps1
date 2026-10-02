# fix-tw.ps1 - Tailscale hosts bootstrap.
# The old version hard-coded 192.200.x.x controlplane/login IPs; those rot and
# break tailnet connectivity on every IP change. This one resolves the current
# addresses through public resolvers (2-of-N consensus), filters anything that
# is not a public unicast address, and only then touches the hosts file.
# Run as Administrator (the script re-elevates itself).

$ErrorActionPreference = 'Stop'
$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
$names = @('controlplane.tailscale.com', 'login.tailscale.com')
$publicResolvers = @('1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222')

# --- self-elevate ---
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Output "Requesting admin rights - accept the UAC prompt."
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
  exit
}

function Test-PublicIp {
  param([string]$ip)
  if ($ip -notmatch '^(\d{1,3}\.){3}\d{1,3}$') { return $false }
  $p = $ip.Split('.') | ForEach-Object { [int]$_ }
  if ($p -contains 0) { return $false }
  if ($p[0] -eq 10) { return $false }                    # RFC1918
  if ($p[0] -eq 172 -and $p[1] -ge 16 -and $p[1] -le 31) { return $false }
  if ($p[0] -eq 192 -and $p[1] -eq 168) { return $false }
  if ($p[0] -eq 127) { return $false }                   # loopback
  if ($p[0] -eq 169 -and $p[1] -eq 254) { return $false } # link-local
  if ($p[0] -eq 100 -and $p[1] -ge 64 -and $p[1] -le 127) { return $false } # CGNAT/tailnet
  if ($p[0] -ge 224) { return $false }                   # multicast/reserved
  if ($p[0] -eq 192 -and $p[1] -eq 0 -and $p[2] -eq 2) { return $false }   # doc
  if ($p[0] -eq 198 -and $p[1] -eq 51 -and $p[2] -eq 100) { return $false } # doc
  if ($p[0] -eq 203 -and $p[1] -eq 0 -and $p[2] -eq 113) { return $false }  # doc
  return $true
}

function Resolve-HostConsensus {
  param([string]$name)
  $votes = @{}
  foreach ($r in $publicResolvers) {
    $ans = $null
    try {
      $ans = Resolve-DnsName -Name $name -Type A -Server $r -NoHostsFile -ErrorAction Stop |
        Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress }
    } catch { continue }
    foreach ($ip in $ans) {
      if ($votes.ContainsKey($ip)) { $votes[$ip]++ } else { $votes[$ip] = 1 }
    }
  }
  # consensus: the address must be seen by at least 2 independent resolvers
  $votes.GetEnumerator() |
    Where-Object { $_.Value -ge 2 -and (Test-PublicIp $_.Key) } |
    Sort-Object Value -Descending |
    ForEach-Object { $_.Key }
}

Write-Output "resolving $($names -join ', ') via public resolvers..."
$resolved = @{}
foreach ($n in $names) {
  $ips = @(Resolve-HostConsensus $n)
  if ($ips.Count -eq 0) {
    Write-Output "FAIL: no 2-resolver consensus for $n"
    foreach ($r in $publicResolvers) {
      try {
        $direct = Resolve-DnsName -Name $n -Type A -Server $r -NoHostsFile -ErrorAction Stop |
          Where-Object { $_.IPAddress } | ForEach-Object { "$($_.IPAddress)" }
        if ($direct) { Write-Output "  $r returned: $($direct -join ', ')" }
      } catch { Write-Output "  $r: query failed" }
    }
  } else {
    $resolved[$n] = $ips[0]
    Write-Output "OK: $n -> $($ips[0]) (votes: $($ips -join ', '))"
  }
}

if ($resolved.Count -lt $names.Count) {
  Write-Output ""
  Write-Output "ABORT: hosts file left untouched - refusing to pin on failed/filtered resolution."
  $null = Read-Host "Press Enter to close"
  exit 1
}

# --- backup + rewrite ---
$backup = "$hostsPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -Path $hostsPath -Destination $backup -Force
Write-Output "backup: $backup"

$lines = @(Get-Content $hostsPath)
$kept = @($lines | Where-Object { $_ -notmatch '^\s*[^#]*\b(controlplane|login)\.tailscale\.com\b' })
foreach ($n in $names) {
  $kept += "$($resolved[$n]) $n"
}
Set-Content -Path $hostsPath -Value ($kept -join [Environment]::NewLine) -Encoding Ascii
Write-Output "hosts: pinned $($resolved.Count) fresh entries"

Write-Output ""
Write-Output "--- hosts tailscale lines: ---"
Get-Content $hostsPath | Select-String -Pattern 'tailscale' | ForEach-Object { $_.Line }

Write-Output ""
Write-Output "--- restart Tailscale service ---"
net stop Tailscale 2>$null
net start Tailscale
Start-Sleep -Seconds 4

Write-Output ""
Write-Output "--- tailscale status: ---"
$ts = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $ts) { $ts = Get-Item 'C:\Program Files\Tailscale\tailscale.exe' -ErrorAction SilentlyContinue }
if ($ts) {
  & $ts.Source status 2>&1 | Select-Object -First 8
} else {
  Write-Output "tailscale.exe not found in PATH or default location"
}

Write-Output ""
$null = Read-Host "Done. Press Enter to close"
