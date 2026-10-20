# 开发环境「装/卸」两个动作，让 annotator-pro 平时保持干净（只有源码）
#
#   powershell -ExecutionPolicy Bypass -File tools\dev-env.ps1 -Action restore   # 要开发/打包前：装回依赖
#   powershell -ExecutionPolicy Bypass -File tools\dev-env.ps1 -Action clean     # 开发完：把 node_modules/dist 挪走
#
# clean 会把 node_modules / dist 搬到 D:\anntarget\_npmcache（同盘移动，瞬时），
# 这样 restore 时可以秒回、不用联网重装；不想要缓存就加 -NoCache（直接删）。
#
# 说明：node_modules 只是构建期依赖，exe 运行不需要它；dist 是 vite 产物，随时可重建。

param(
    [ValidateSet("restore", "clean")]
    [string]$Action = "restore",
    [string]$Cache = "D:\anntarget\_npmcache",
    [switch]$NoCache
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Size-MB([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) { return 0 }
    $s = (Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
    return [math]::Round($s / 1MB, 0)
}

function Remove-LinkOnly([string]$p) {
    # 目录联接必须用 rmdir 删（不加 /s），否则会顺着链接把目标内容一起删掉
    if (-not (Test-Path -LiteralPath $p)) { return }
    $item = Get-Item -LiteralPath $p -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        cmd /c rmdir "$p"
    } else {
        Remove-Item -LiteralPath $p -Recurse -Force
    }
}

if ($Action -eq "clean") {
    Write-Host "=== 清理项目目录（把构建产物挪出项目）===" -ForegroundColor Cyan
    foreach ($name in @("node_modules", "dist")) {
        $p = Join-Path $repo $name
        if (-not (Test-Path -LiteralPath $p)) { Write-Host "$name : 本来就没了"; continue }
        $mb = Size-MB $p
        if ($NoCache) {
            Remove-LinkOnly $p
            Write-Host ("{0} : 已删除（{1} MB）" -f $name, $mb) -ForegroundColor Green
            continue
        }
        if (-not (Test-Path -LiteralPath $Cache)) { New-Item -ItemType Directory -Path $Cache -Force | Out-Null }
        $dest = Join-Path $Cache $name
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
        Move-Item -LiteralPath $p -Destination $dest
        Write-Host ("{0} : 已挪到 {1}（{2} MB）" -f $name, $dest, $mb) -ForegroundColor Green
    }
    $left = (Get-ChildItem -LiteralPath $repo -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch "\\\.git\\" } | Measure-Object Length -Sum).Sum
    Write-Host ("项目目录现在: {0:N1} MB（不含 .git）" -f ($left / 1MB)) -ForegroundColor Cyan
    exit 0
}

# ---- restore ----
Write-Host "=== 恢复开发环境 ===" -ForegroundColor Cyan
foreach ($name in @("node_modules", "dist")) {
    $p = Join-Path $repo $name
    if (Test-Path -LiteralPath $p) {
        Write-Host "$name : 已在项目里（$(Size-MB $p) MB）"
        continue
    }
    $cached = Join-Path $Cache $name
    if (Test-Path -LiteralPath $cached) {
        Move-Item -LiteralPath $cached -Destination $p
        Write-Host ("{0} : 已从缓存挪回（{1} MB）" -f $name, (Size-MB $p)) -ForegroundColor Green
    } elseif ($name -eq "node_modules") {
        Write-Host "node_modules : 缓存里没有，执行 npm ci ..." -ForegroundColor Yellow
        npm ci --no-audit --no-fund
    } else {
        Write-Host "dist : 缓存里没有（下次 npm run build 会生成）"
    }
}
Write-Host "`n完成。可以 npm run dev / build / check / tauri build 了。" -ForegroundColor Green
