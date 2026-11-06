# Starts the dev-agent setup for Antigravity. Run it from the folder you want to work in:
#   powershell -ExecutionPolicy Bypass -File C:\path\to\dev-agent\setup.ps1 [--scope global] [--yes]
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 18 or newer is required. Install it, then run this again:"
  Write-Host "  winget install OpenJS.NodeJS.LTS      (or https://nodejs.org)"
  exit 1
}
& node (Join-Path $PSScriptRoot "scripts\setup.mjs") @args
exit $LASTEXITCODE
