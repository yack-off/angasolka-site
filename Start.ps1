$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$angasolkaNode = Get-Command node -ErrorAction SilentlyContinue
if ($angasolkaNode) { $angasolkaNodePath = $angasolkaNode.Source } else {
  $angasolkaNodePath = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
}
if (-not (Test-Path -LiteralPath $angasolkaNodePath)) { throw 'Install Node.js 24 LTS and pnpm first.' }
if (-not (Test-Path -LiteralPath 'node_modules/tsx')) { throw 'Run pnpm install --frozen-lockfile first.' }
Write-Host 'Angasolka: http://127.0.0.1:4180 — keep this window open.'
& $angasolkaNodePath --import tsx src/server.ts
