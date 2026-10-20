# 把 annotator-pro 发布到 GitHub 的干净副本
#
# 用法（在仓库根目录或任意位置）：
#   powershell -ExecutionPolicy Bypass -File tools\publish-to-github.ps1
#   powershell -ExecutionPolicy Bypass -File tools\publish-to-github.ps1 -Message "feat: xxx"
#
# 做什么：
#   1) 只复制「可以公开」的文件到目标目录（默认 ..\..\github-upload\annotator-pro）
#   2) 用 tools\README.public.md / tools\gitignore.public 覆盖 README.md / .gitignore
#   3) 扫一遍敏感串（本机绝对路径、用户名、内部文档名），有命中就直接失败
#   4) 目标目录没有 .git 就 git init，然后 add + commit（**不 push**，推送由你手动做）
#
# 刻意不发布：开发文档（交接/修复日志/待办/方案/开发说明/NEXT）、python/ 旧后端、
# scripts/ 与 inspect_onnx.cjs 这类临时脚本、启动脚本（含本机绝对路径）、
# dist/、node_modules/、src-tauri/.cargo（target-dir 指向 D:\anntarget）、测试图片。

param(
    [string]$Destination = "",
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
if (-not $Destination) {
    $Destination = Join-Path (Split-Path -Parent $repo) "github-upload\annotator-pro"
}

Write-Host "仓库: $repo" -ForegroundColor Cyan
Write-Host "目标: $Destination" -ForegroundColor Cyan

# ---------- 1. 准备目录（保留 .git，方便迭代提交） ----------
if (Test-Path $Destination) {
    Get-ChildItem -LiteralPath $Destination -Force | Where-Object { $_.Name -ne ".git" } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
} else {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

# ---------- 2. 白名单复制 ----------
$files = @(
    "package.json", "package-lock.json", "index.html", "vite.config.ts",
    "svelte.config.js", "tsconfig.json", "tsconfig.node.json"
)
foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $repo $f) -Destination $Destination -Force
}

Copy-Item -LiteralPath (Join-Path $repo "src") -Destination $Destination -Recurse -Force

# 先把 src-tauri 目录建好，否则 Copy-Item 把文件当"叶子"会报 container/leaf 错
New-Item -ItemType Directory -Path (Join-Path $Destination "src-tauri") -Force | Out-Null

$tauriFiles = @("Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json")
foreach ($f in $tauriFiles) {
    Copy-Item -LiteralPath (Join-Path $repo "src-tauri\$f") -Destination (Join-Path $Destination "src-tauri") -Force
}
foreach ($d in @("icons", "capabilities", "src", "sidecar")) {
    Copy-Item -LiteralPath (Join-Path $repo "src-tauri\$d") -Destination (Join-Path $Destination "src-tauri") -Recurse -Force
}

# sidecar 目录里如果有 __pycache__ / models，别带出去
$junk = Get-ChildItem -LiteralPath (Join-Path $Destination "src-tauri\sidecar") -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "__pycache__" -or $_.Name -eq "models" }
foreach ($j in $junk) { Remove-Item -LiteralPath $j.FullName -Recurse -Force }

# ---------- 3. README / .gitignore ----------
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "README.public.md") -Destination (Join-Path $Destination "README.md") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "gitignore.public") -Destination (Join-Path $Destination ".gitignore") -Force

# ---------- 4. 敏感串扫描 ----------
$patterns = @(
    "79458",            # 本机用户名
    "桌面\\图像标注",    # 本机项目路径
    "D:\\anntarget",    # 本机编译输出
    "E:\\Doubao",       # 本机模型目录
    "交接文档", "修复日志", "待办清单", "实施方案", "开发说明日志", "NEXT.md",
    "面试准备"
)
$hits = @()
$textExt = @(".rs", ".ts", ".svelte", ".js", ".json", ".md", ".py", ".toml", ".html", ".css", ".cjs")
Get-ChildItem -LiteralPath $Destination -Recurse -File -Force |
    Where-Object { $textExt -contains $_.Extension } |
    ForEach-Object {
        $file = $_
        foreach ($p in $patterns) {
            if (Select-String -LiteralPath $file.FullName -Pattern $p -SimpleMatch -Quiet) {
                $hits += "$($file.FullName)  <=  $p"
            }
        }
    }

if ($hits.Count -gt 0) {
    Write-Host "`n发现敏感内容，已中止（不会提交）：" -ForegroundColor Red
    $hits | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`n敏感串扫描: 通过" -ForegroundColor Green

# ---------- 5. 统计 + git ----------
$all = Get-ChildItem -LiteralPath $Destination -Recurse -File -Force | Where-Object { $_.FullName -notmatch "\\\.git\\" }
$mb = [math]::Round(($all | Measure-Object Length -Sum).Sum / 1MB, 2)
Write-Host ("待提交: {0} 个文件, {1} MB" -f $all.Count, $mb) -ForegroundColor Cyan

Push-Location $Destination
try {
    if (-not (Test-Path (Join-Path $Destination ".git"))) {
        git init -b main | Out-Null
        Write-Host "已 git init（main）" -ForegroundColor Green
    }
    git add -A
    if (-not $Message) {
        $Message = "chore: sync public snapshot"
    }
    git commit -m $Message --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host "没有可提交的改动（或 commit 被拒绝）" -ForegroundColor Yellow
    } else {
        git log --oneline -1
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "完成。推送到 GitHub（首次）：" -ForegroundColor Green
Write-Host "  cd `"$Destination`""
Write-Host "  git remote add origin https://github.com/<你的账号>/<仓库名>.git"
Write-Host "  git push -u origin main"
