$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$angasolkaNode = Get-Command node -ErrorAction SilentlyContinue
$angasolkaNodePath = if ($angasolkaNode) {$angasolkaNode.Source} else {Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
if (-not (Test-Path -LiteralPath $angasolkaNodePath)) {throw 'Node.js 24 is required.'}
if (-not (Test-Path -LiteralPath 'node_modules/tsx')) {throw 'Run pnpm install --frozen-lockfile first.'}
if (-not (Test-Path -LiteralPath 'data/tools/cloudflared.exe')) {
    New-Item -ItemType Directory -Force 'data/tools' | Out-Null
    $release = Invoke-RestMethod 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
    $asset = $release.assets | Where-Object {$_.name -eq 'cloudflared-windows-amd64.exe'}
    if (-not $asset.digest) {throw 'Missing official SHA256 digest.'}
    Invoke-WebRequest $asset.browser_download_url -OutFile 'data/tools/cloudflared.download'
    $actualHash = (Get-FileHash -LiteralPath 'data/tools/cloudflared.download' -Algorithm SHA256).Hash.ToLower()
    if ($asset.digest -ne ('sha256:' + $actualHash)) {throw 'Cloudflared checksum mismatch.'}
    Move-Item -LiteralPath 'data/tools/cloudflared.download' -Destination 'data/tools/cloudflared.exe'
}
New-Item -ItemType Directory -Force 'data/demo' | Out-Null
if (Test-Path 'data/demo/running.json') {
    $state = Get-Content 'data/demo/running.json' -Raw | ConvertFrom-Json
    if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) {Write-Host 'Demo is already running. See data/demo/links.txt'; exit}
}
$demoProcess = Start-Process -FilePath $angasolkaNodePath -ArgumentList @('--import','tsx','src/demo.ts') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput 'data/demo/stdout.log' -RedirectStandardError 'data/demo/stderr.log' -PassThru
Write-Host "Demo is starting (PID $($demoProcess.Id)). Links: data/demo/links.txt. Stop: Stop-Demo.ps1"
