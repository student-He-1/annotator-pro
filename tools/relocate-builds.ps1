# 把「打包相关的大目录」统一搬到 D:\anntarget，项目里只留目录联接（junction）
#
# 搬的东西：
#   annotator-pro\node_modules  ->  D:\anntarget\node_modules   (npm 依赖，~216 MB)
#   annotator-pro\dist          ->  D:\anntarget\dist           (vite 产物，~26 MB)
#   Rust 产物本来就在 D:\anntarget（src-tauri\.cargo\config.toml 里 target-dir）
#
# 为什么要「实体搬走 + 联接回来」而不是直接改配置：
#   · node 的模块解析、vite/npm/tauri 都认 `项目\node_modules` 这个位置，不能简单指走；
#   · 用 Windows 目录联接（junction，无需管理员）后，所有命令一行都不用改，
#     但文件实际都在 D 盘。
#
# ⚠️ 注意：`npm ci` 会先删掉 node_modules 再重装 —— 联接近乎总会被它换回真目录。
#    重装依赖之后再跑一次本脚本即可（脚本是幂等的）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\relocate-builds.ps1
#   powershell -ExecutionPolicy Bypass -File tools\relocate-builds.ps1 -WhatIf   (只看不做)

param(
    [string]$Target = "D:\anntarget",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Test-Junction([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $item = Get-Item -LiteralPath $path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Size-MB([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
    return [math]::Round($sum / 1MB, 0)
}

$jobs = @(
    @{ Name = "node_modules"; Link = Join-Path $repo "node_modules"; Target = Join-Path $Target "node_modules" },
    @{ Name = "dist";         Link = Join-Path $repo "dist";         Target = Join-Path $Target "dist" }
)

foreach ($j in $jobs) {
    Write-Host "`n=== $($j.Name) ===" -ForegroundColor Cyan
    if (Test-Junction $j.Link) {
        Write-Host "已经是联接：$($j.Link) -> $($j.Target)" -ForegroundColor Green
        continue
    }
    if (-not (Test-Path -LiteralPath $j.Link)) {
        Write-Host "项目里没有 $($j.Name)，直接建联接" -ForegroundColor Yellow
    } else {
        # 真目录：搬到目标位置（同盘搬迁基本是瞬时的）
        $size = Size-MB $j.Link
        Write-Host ("搬走实体目录（{0} MB）：{1} -> {2}" -f $size, $j.Link, $j.Target) -ForegroundColor Yellow
        if (-not $WhatIf) {
            if (-not (Test-Path -LiteralPath $Target)) {
                New-Item -ItemType Directory -Path $Target -Force | Out-Null
            }
            # 目标已存在时先清空（例如 dist 之前被建过）
            if (Test-Path -LiteralPath $j.Target) {
                Remove-Item -LiteralPath $j.Target -Recurse -Force
            }
            Move-Item -LiteralPath $j.Link -Destination $j.Target
        }
    }
    if ($WhatIf) {
        Write-Host "（-WhatIf：没有实际改动）" -ForegroundColor DarkGray
        continue
    }
    if (-not (Test-Path -LiteralPath $j.Target)) {
        New-Item -ItemType Directory -Path $j.Target -Force | Out-Null
    }
    New-Item -ItemType Junction -Path $j.Link -Target $j.Target | Out-Null
    Write-Host "已建联接：$($j.Link) -> $($j.Target)" -ForegroundColor Green
}

Write-Host "`n=== 结果 ===" -ForegroundColor Cyan
foreach ($j in $jobs) {
    $isLink = Test-Junction $j.Link
    $kind = if ($isLink) { "联接" } else { "真实目录（需要再跑一次本脚本）" }
    Write-Host ("{0,-14} {1,-8} 目标: {2}  ({3} MB)" -f $j.Name, $kind, $j.Target, (Size-MB $j.Target))
}
$projectSize = 0
foreach ($j in $jobs) {
    # 只算项目侧「非联接」的占用（正常情况应该是 0）
    if (-not (Test-Junction $j.Link) -and (Test-Path -LiteralPath $j.Link)) { $projectSize += (Size-MB $j.Link) }
}
Write-Host ("项目目录里还残留的打包体积: {0} MB（应为 0）" -f $projectSize) -ForegroundColor Cyan
Write-Host "`n提示：以后执行 npm ci / npm install 之后，若发现 node_modules 变回真实目录，重跑本脚本即可。" -ForegroundColor DarkGray
