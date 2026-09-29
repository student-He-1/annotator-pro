# Annotator Pro - Python Backend Starter
# Right-click -> Run with PowerShell, or: powershell -ExecutionPolicy Bypass -File start_backend.ps1

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Annotator Pro Backend Starting..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$env:TORCH_HOME = "E:\TorchHub"
$env:TORCHINDUCTOR_CACHE_DIR = "E:\TorchHub\inductor_cache"
$env:TRITON_CACHE_DIR = "E:\TorchHub\triton_cache"
$env:PYTHONIOENCODING = "utf-8"

$python = "D:\79458\Documents\anaconda3\envs\deeplearning\python.exe"
$script = "D:\桌面\图像标注\annotator-pro\src-tauri\target\release\sidecar\sam_server.py"

Write-Host "[1/2] Loading SAM3 model (10-30s, do not close)..." -ForegroundColor Yellow
Write-Host ""

& $python $script

Write-Host ""
Write-Host "Backend exited. Press any key to close..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
