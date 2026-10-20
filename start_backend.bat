@echo off
chcp 65001 >nul
title Annotator Pro - Python Backend
echo ========================================
echo   Annotator Pro Backend Starting...
echo ========================================
echo.

REM ===== 请根据你的环境修改以下配置 =====
set PYTHON_EXE=python
set SAM3_MODEL_PATH=E:\models\sam3.pt
set POSE_MODEL_PATH=E:\models\yolov8n-pose.pt
set TORCH_HOME=E:\TorchHub
REM =======================================

set TORCHINDUCTOR_CACHE_DIR=%TORCH_HOME%\inductor_cache
set TRITON_CACHE_DIR=%TORCH_HOME%\triton_cache
set PYTHONIOENCODING=utf-8

echo [1/2] Loading SAM3 model (10-30s, do not close)...
echo.

"%PYTHON_EXE%" "%~dp0src-tauri\sidecar\sam_server.py"

echo.
echo Backend exited. Press any key to close...
pause >nul
