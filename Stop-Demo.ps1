$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path 'data/demo/running.json')) {Write-Host 'Demo is not running.'; exit}
New-Item -ItemType File -Force 'data/demo/stop' | Out-Null
Write-Host 'Shutdown requested. The site, database and tunnel will close together.'
