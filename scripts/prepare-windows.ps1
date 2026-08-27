[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ParserBuildScript = Join-Path $RepoRoot "services/module-parser/scripts/build.ps1"
$BuiltSidecar = Join-Path $RepoRoot "services/module-parser/dist/coc-module-parser-x86_64-pc-windows-msvc.exe"
$TauriBinaryDirectory = Join-Path $RepoRoot "apps/desktop/src-tauri/binaries"
$TauriSidecar = Join-Path $TauriBinaryDirectory "module-parser-x86_64-pc-windows-msvc.exe"

Push-Location $RepoRoot
try {
    & pnpm --filter "@coc-room/protocol" build
    if ($LASTEXITCODE -ne 0) { throw "Shared protocol build failed with exit code $LASTEXITCODE" }

    & $ParserBuildScript
    if ($LASTEXITCODE -ne 0) { throw "Python sidecar build failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $BuiltSidecar -PathType Leaf)) {
        throw "Sidecar build did not produce $BuiltSidecar"
    }

    New-Item -ItemType Directory -Force -Path $TauriBinaryDirectory | Out-Null
    Copy-Item -LiteralPath $BuiltSidecar -Destination $TauriSidecar -Force
    Write-Host "Prepared Tauri sidecar: $TauriSidecar"
}
finally {
    Pop-Location
}
