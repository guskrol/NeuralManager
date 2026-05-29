param(
    [int]$Port = 3000,
    [string]$BindHost = "127.0.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($null -ne $nodeCommand) { $nodeCommand.Source } else { $null }
if ([string]::IsNullOrWhiteSpace($node)) {
    $bundledNode = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
        $node = $bundledNode
    }
}

if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) {
    throw "Node.js was not found. Install Node.js on this PC, then open a new PowerShell and run this script again."
}

$env:PORT = "$Port"
$env:BIND_HOST = $BindHost
Set-Location $root
if ($BindHost -eq "0.0.0.0") {
    Write-Host "Starting NeuraL Farm Control on this computer and local network, port $Port"
}
else {
    Write-Host "Starting NeuraL Farm Control at http://localhost:$Port"
}
Write-Host "Keep this window open while using the panel."
& $node ".\server.mjs"
