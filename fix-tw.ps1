$h = 'C:\Windows\System32\drivers\etc\hosts'
$want = @(
  '192.200.0.108 controlplane.tailscale.com',
  '192.200.0.113 login.tailscale.com'
)
$lines = @(Get-Content $h)
$add = @($want | Where-Object { $lines -notcontains $_ })
if ($add.Count -gt 0) {
  Add-Content -Path $h -Value ($add -join [Environment]::NewLine)
  Write-Output ("hosts: added " + $add.Count + " lines")
} else {
  Write-Output "hosts: already in place"
}
Write-Output "--- hosts tailscale lines: ---"
Get-Content $h | Select-String -Pattern 'tailscale' | ForEach-Object { $_.Line }

Write-Output "--- restart Tailscale service ---"
net stop Tailscale 2>$null
net start Tailscale
Start-Sleep -Seconds 4
Write-Output "--- tailscale status: ---"
& 'C:\Program Files\Tailscale\tailscale.exe' status 2>&1 | Select-Object -First 8

Write-Output ""
$null = Read-Host "Done. Press Enter to close"
