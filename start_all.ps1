# Annotator Pro - One Click Launcher
# Starts Python backend + Vite dev server + opens browser

$ErrorActionPreference = "Continue"
$root = $PSScriptRoot

Write-Host "=== Annotator Pro Launcher ===" -ForegroundColor Cyan
Write-Host ""

# 1. Start Python backend
Write-Host "[1/3] Starting Python backend (SAM3 loading, 10-30s)..." -ForegroundColor Yellow
$env:TORCH_HOME = "E:\TorchHub"
$env:TORCHINDUCTOR_CACHE_DIR = "E:\TorchHub\inductor_cache"
$env:TRITON_CACHE_DIR = "E:\TorchHub\triton_cache"
$env:PYTHONIOENCODING = "utf-8"
# 模型路径走环境变量（源码里不再写死绝对路径，见第 24 批）
$env:SAM3_MODEL_PATH = "E:\Doubao download\sam3.pt"
$env:POSE_MODEL_PATH = "E:\Doubao download\yolov8n-pose.pt"

$backendScript = Join-Path $root "src-tauri\sidecar\sam_server.py"
$backend = Start-Process -FilePath "D:\79458\Documents\anaconda3\envs\deeplearning\python.exe" `
    -ArgumentList "`"$backendScript`"" `
    -WorkingDirectory $root `
    -PassThru -WindowStyle Normal

# Wait for backend port 1421
Write-Host "      Waiting for backend on port 1421..." -ForegroundColor Gray
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep 2
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:1421/health" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Write-Host "      ...waiting ($($i*2)s)" -ForegroundColor Gray
}

if (-not $ready) {
    Write-Host "WARNING: Backend not ready after 120s, continuing anyway..." -ForegroundColor Red
} else {
    Write-Host "      Backend ready!" -ForegroundColor Green
}

# 2. Start Vite dev server
Write-Host ""
Write-Host "[2/3] Starting frontend dev server..." -ForegroundColor Yellow
$frontend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "cd /d `"$root`" && npm run dev" `
    -PassThru -WindowStyle Normal

# Wait for frontend port 1420
Write-Host "      Waiting for frontend on port 1420..." -ForegroundColor Gray
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 1
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:1420" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { break }
    } catch {}
}

# 3. Open browser
Write-Host ""
Write-Host "[3/3] Opening browser..." -ForegroundColor Yellow
Start-Process "http://localhost:1420"

Write-Host ""
Write-Host "=== Annotator Pro is running ===" -ForegroundColor Green
Write-Host "  Backend:  http://127.0.0.1:1421"
Write-Host "  Frontend: http://localhost:1420"
Write-Host ""
Write-Host "Close this window to stop both servers." -ForegroundColor Gray
Write-Host "Press Ctrl+C to exit." -ForegroundColor Gray

# Keep script alive
try {
    while ($true) { Start-Sleep 10 }
} finally {
    Write-Host "Shutting down..." -ForegroundColor Yellow
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
}
