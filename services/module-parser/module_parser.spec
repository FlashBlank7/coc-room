# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


project_dir = Path(SPECPATH).resolve()
datas = []
binaries = []
hiddenimports = []
for package in ("langgraph", "pydantic", "docx", "httpx", "pypdf", "pypdfium2"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden
hiddenimports += collect_submodules("langgraph")
hiddenimports += ["PIL.Image", "PIL.PngImagePlugin"]

a = Analysis(
    [str(project_dir / "src" / "coc_module_parser" / "__main__.py")],
    pathex=[str(project_dir / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="coc-module-parser",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
