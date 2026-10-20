@echo off
chcp 65001 >nul
title Annotator Pro - Python Backend
echo ========================================
echo   Annotator Pro Backend Starting...
echo ========================================
echo.

set TORCH_HOME=E:\TorchHub
set TORCHINDUCTOR_CACHE_DIR=E:\TorchHub\inductor_cache
set TRITON_CACHE_DIR=E:\TorchHub\triton_cache
set PYTHONIOENCODING=utf-8

echo [1/2] Loading SAM3 model (10-30s, do not close)...
echo.

"D:\79458\Documents\anaconda3\envs\deeplearning\python.exe" "%~dp0src-tauri\sidecar\sam_server.py"

echo.
echo Backend exited. Press any key to close...
pause >nul
