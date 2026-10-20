# Annotator Pro 一键启动：后端 + 前端 + 浏览器
# 用法：双击 start_all.bat，或 powershell -ExecutionPolicy Bypass -File start_all.ps1

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

# ===== 配置（按你的环境修改）=====
$pythonExe = "python"
$sam3Model = "E:\models\sam3.pt"
$poseModel = "E:\models\yolov8n-pose.pt"
$torchHome = "E:\TorchHub"
$fePort = 1420
$bePort = 1421
# ===================================

$env:SAM3_MODEL_PATH = $sam3Model
$env:POSE_MODEL_PATH = $poseModel
$env:TORCH_HOME = $torchHome
$env:TORCHINDUCTOR_CACHE_DIR = "$torchHome\inductor_cache"
$env:TRITON_CACHE_DIR = "$torchHome\triton_cache"
$env:PYTHONIOENCODING = "utf-8"

Write-Host "=== [1/3] Starting Python backend (port $bePort) ===" -ForegroundColor Cyan
$backend = Start-Process -FilePath $pythonExe `
    -ArgumentList "`"$repo\src-tauri\sidecar\sam_server.py`"" `
    -PassThru -NoNewWindow

Write-Host "=== [2/3] Starting frontend dev server (port $fePort) ===" -ForegroundColor Cyan
Set-Location $repo
$frontend = Start-Process -FilePath "npm" -ArgumentList "run","dev" -PassThru -NoNewWindow

Write-Host "=== [3/3] Waiting for frontend to come up... ===" -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$fePort" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}

if ($ready) {
    Write-Host "=== Opening browser ===" -ForegroundColor Green
    Start-Process "http://localhost:$fePort"
    Write-Host ""
    Write-Host "Annotator Pro is running." -ForegroundColor Green
    Write-Host "  Frontend: http://localhost:$fePort"
    Write-Host "  Backend:  http://localhost:$bePort"
    Write-Host ""
    Write-Host "Close this window to stop both processes." -ForegroundColor Yellow
} else {
    Write-Host "Frontend did not start within 30s. Check the npm output above." -ForegroundColor Red
}

# 保持窗口打开，关闭时同时杀掉子进程
try {
    Wait-Process -Id $frontend.Id -ErrorAction Stop
} finally {
    if (-not $backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
    if (-not $frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
}
