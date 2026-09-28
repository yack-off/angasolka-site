$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$angasolkaNode = Get-Command node -ErrorAction SilentlyContinue
$angasolkaNodePath = if ($angasolkaNode) {$angasolkaNode.Source} else {Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
& $angasolkaNodePath --import tsx src/demo-telegram-setup.ts
Read-Host 'Press Enter to close'
