[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$ParserRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is required. Install it from https://docs.astral.sh/uv/ and retry."
}

Push-Location $ParserRoot
try {
    uv sync --locked --extra dev --python 3.12
    uv run pyinstaller --clean --noconfirm module_parser.spec

    $BuiltExecutable = Join-Path $ParserRoot "dist/coc-module-parser.exe"
    if (-not (Test-Path -LiteralPath $BuiltExecutable -PathType Leaf)) {
        throw "PyInstaller did not produce $BuiltExecutable"
    }
    $SidecarExecutable = Join-Path $ParserRoot "dist/coc-module-parser-$TargetTriple.exe"
    Copy-Item -LiteralPath $BuiltExecutable -Destination $SidecarExecutable -Force
    Write-Host "Tauri sidecar: $SidecarExecutable"
}
finally {
    Pop-Location
}
