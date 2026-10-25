#!/usr/bin/env pwsh
# 把当前 HEAD 的「干净副本」推送到对外仓库。
#
# 背景：本仓库的早期提交里曾经写入过真实的百度 OCR AK/SK。
# 本地保留完整历史（方便回溯），但**对外仓库绝不能带着这段历史**。
# 因此每次推送都走这个脚本：导出当前快照 → 密钥扫描 → 全新单提交 → 强推。
#
# 用法：
#   pwsh scripts/push-clean.ps1                          # 用默认提交信息
#   pwsh scripts/push-clean.ps1 -Message "fix: xxx"      # 指定提交信息
#   pwsh scripts/push-clean.ps1 -DryRun                  # 只做导出与扫描，不推送
#   pwsh scripts/push-clean.ps1 -Remote origin           # 换目标远端

[CmdletBinding()]
param(
  [string]$Message = '',
  [string]$Remote = 'org',
  [string]$Branch = 'main',
  # 对外提交的作者。默认用 GitHub 账号的 noreply 地址，避免把本机 / 个人邮箱写进公开历史
  [string]$AuthorName = 'Megalomanian',
  [string]$AuthorEmail = 'Megalomanian@users.noreply.github.com',
  [switch]$DryRun,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }

# --- 1. 工作区必须干净：避免把「没提交的临时改动」一起推出去 -----------------
Write-Step '检查工作区'
$dirty = git status --porcelain
if ($dirty) {
  Write-Host $dirty
  Fail '工作区有未提交的改动，请先提交再推送（本脚本只推 HEAD 的内容）'
}

$headSha = (git rev-parse --short HEAD).Trim()
Write-Step "当前 HEAD: $headSha"

# --- 2. 导出当前快照到临时目录 ---------------------------------------------
$stage = Join-Path ([IO.Path]::GetTempPath()) ("jwgl-clean-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Step "导出快照到 $stage"
# 用 worktree 而不是 git archive：Windows 自带 tar 处理中文文件名会报
# 「Archive entry has empty or unreadable filename」。worktree 检出的是 HEAD
# 的已跟踪文件，天然不含 config.py 这类被 .gitignore 排除的本机配置。
git worktree add --detach -q $stage HEAD
if ($LASTEXITCODE -ne 0) { Fail 'git worktree add 失败' }

# 干净副本里不需要 worktree 的 .git 指针
Remove-Item -LiteralPath (Join-Path $stage '.git') -Force -Recurse -ErrorAction SilentlyContinue

# --- 3. 密钥扫描：命中即中止 -----------------------------------------------
# 精确的敏感值（真实 AK/SK、学号密码、姓名、票据）**不在这个脚本里**，
# 而是从本机的 scripts/sensitive.txt 读取 —— 脚本本身要公开，若把密钥写在脚本
# 里，脚本自己就成了泄露源（base64 也不是加密）。
#
# 这里只放「结构性」规则：不指向任何具体个人的模式。
Write-Step '扫描敏感信息'
$rules = @(
  @{ Name = '校内私有 IP';       Pattern = '\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b' },
  @{ Name = '疑似百度 AK/SK 赋值'; Pattern = '(?i)(API_KEY|SECRET_KEY)\s*=\s*"[A-Za-z0-9]{16,}"' },
  @{ Name = '凭证写死在脚本里';   Pattern = '(?i)(access[_-]?token|password|passwd|secret)\s*[:=]\s*"[^"\s]{8,}"' }
)

# 从本机清单追加「一字不差」的精确规则
$sensitiveList = Join-Path $repoRoot 'scripts/sensitive.txt'
if (Test-Path $sensitiveList) {
  $lines = Get-Content -LiteralPath $sensitiveList |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }
  $i = 0
  foreach ($value in $lines) {
    $i++
    $rules += @{ Name = "本机敏感值 #$i"; Pattern = [regex]::Escape($value); Literal = $true }
  }
  Write-Host "  已加载本机敏感值 $($lines.Count) 条" -ForegroundColor DarkGray
} else {
  Write-Host '  ⚠ 未找到 scripts/sensitive.txt，只做结构规则扫描（建议先 copy scripts\sensitive.example.txt scripts\sensitive.txt 并填入真实值）' -ForegroundColor Yellow
}

# 这些文件本身是「规则的容器」，不参与扫描，否则会自己命中自己
$selfSkipped = @('scripts/push-clean.ps1', 'docs/推送约定.md', 'scripts/sensitive.example.txt')

$files = Get-ChildItem -Path $stage -Recurse -File | Where-Object {
  $_.Extension -notin '.png', '.jpg', '.jpeg', '.ico', '.crx', '.pem', '.zip'
}

$hits = @()
foreach ($f in $files) {
  $rel = $f.FullName.Replace($stage + [IO.Path]::DirectorySeparatorChar, '').Replace('\', '/')
  if ($selfSkipped -contains $rel) { continue }
  $content = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
  if (-not $content) { continue }
  foreach ($rule in $rules) {
    if ($content -match $rule.Pattern) {
      $hits += "  [$($rule.Name)] $rel"
    }
  }
}

if ($hits.Count -gt 0) {
  Write-Host ($hits -join [Environment]::NewLine) -ForegroundColor Red
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  git -C $repoRoot worktree prune 2>$null
  Fail '扫描到敏感信息，已中止推送。请先脱敏并提交。'
}
Write-Host "✓ 未发现敏感信息（已检查 $($files.Count) 个文件）" -ForegroundColor Green

# 顺带确认本机配置没被打包进去
if (Test-Path (Join-Path $stage 'legacy/python/config.py')) {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  git -C $repoRoot worktree prune 2>$null
  Fail 'legacy/python/config.py 出现在快照里（应被 .gitignore 排除），已中止'
}

if ($DryRun) {
  if ($KeepStage) {
    Write-Step "DryRun 结束（快照保留在 $stage）"
  } else {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    git -C $repoRoot worktree prune 2>$null
    Write-Step 'DryRun 结束：扫描通过，未推送（快照已清理）'
  }
  exit 0
}

# --- 4. 在临时目录建全新单提交仓库 -----------------------------------------
Write-Step '创建干净副本仓库'
Push-Location $stage
try {
  git init -q -b $Branch
  git config user.name $AuthorName
  git config user.email $AuthorEmail
  git add -A
  if (-not $Message) {
    $Message = (git -C $repoRoot log -1 --pretty=%B).Trim()
  }
  $Message = $Message + "`n`n干净副本：不含密钥与会话票据，历史重建为单次提交。"
  git commit -q -m $Message

  # --- 5. 强推到对外仓库 ---------------------------------------------------
  $target = (git -C $repoRoot remote get-url $Remote).Trim()
  if (-not $target) { Fail "远端 $Remote 不存在，请先 git remote add $Remote <url>" }
  Write-Step "推送干净副本到 $Remote ($target)"
  git remote add target $target
  git push --force target "$Branch`:$Branch"
  if ($LASTEXITCODE -ne 0) { Fail '推送失败' }

  $newSha = (git rev-parse --short HEAD).Trim()
  Write-Host "✓ 已推送（对外 HEAD: $newSha，本地原历史保持不变）" -ForegroundColor Green
} finally {
  Pop-Location
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  # 清掉主仓库里指向临时快照的 worktree 登记（.git 指针已删，rm 会失败）
  git -C $repoRoot worktree prune 2>$null
}
