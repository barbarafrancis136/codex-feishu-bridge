[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$HostName = "43.153.132.237",
  [string]$UserName = "root",
  [string]$PrivateKeyPath = "C:\Users\Administrator\.ssh\codex_deploy_key",
  [string]$RemoteAppDir = "/root/snap/codex/common/projects/codex-feishu-bridge-v2/app",
  [string]$RemoteTmpBase = "/tmp",
  [switch]$SkipInstall,
  [switch]$SkipTests,
  [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"
$IsWhatIf = [bool]$WhatIfPreference

function Write-Step($Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  if ($IsWhatIf) {
    Write-Host "[whatif] $FilePath $($ArgumentList -join ' ')" -ForegroundColor Yellow
    return
  }

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $FilePath $($ArgumentList -join ' ')"
  }
}

function New-RemoteShellScript {
  param(
    [string]$RemoteAppDir,
    [bool]$RunInstall,
    [bool]$RunTests,
    [bool]$RunRestart
  )

  $steps = @(
    'set -euo pipefail',
    ('APP_DIR="{0}"' -f $RemoteAppDir),
    'cd "$APP_DIR"',
    'echo "[deploy] app dir: $APP_DIR"',
    'echo "[deploy] node: $(node -v)"',
    'echo "[deploy] npm: $(npm -v)"'
  )

  if ($RunInstall) {
    $steps += 'echo "[deploy] installing dependencies"'
    $steps += 'npm install'
  }

  if ($RunTests) {
    $steps += 'echo "[deploy] running appointment tests"'
    $steps += 'npm run test:appointment'
  }

  if ($RunRestart) {
    $steps += 'echo "[deploy] restarting bridge"'
    $steps += 'bash ./scripts/restart-feishu-bot-cloud.sh'
  }

  $steps += 'echo "[deploy] service status"'
  $steps += 'systemctl status codex-feishu-bridge.service --no-pager --lines=20 || true'
  $steps += 'echo "[deploy] recent bridge log"'
  $steps += 'journalctl -u codex-feishu-bridge.service -n 40 --no-pager || true'
  return ($steps -join "`n")
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$StagingDir = Join-Path $RepoRoot ".deploy"
$PackagePath = Join-Path $StagingDir "codex-feishu-bridge-cloud.tar.gz"

if (!(Test-Path $PrivateKeyPath)) {
  throw "Private key not found: $PrivateKeyPath"
}

if ($IsWhatIf) {
  Write-Step "Preview cloud deploy plan"
  Write-Host "Host:           $HostName"
  Write-Host "User:           $UserName"
  Write-Host "Private key:    $PrivateKeyPath"
  Write-Host "Remote app dir: $RemoteAppDir"
  Write-Host "Skip install:   $SkipInstall"
  Write-Host "Skip tests:     $SkipTests"
  Write-Host "Skip restart:   $SkipRestart"
  Write-Host ""
  Write-Host "This preview skips packaging, upload, extraction, and restart." -ForegroundColor Yellow
  exit 0
}

if (!(Test-Path $StagingDir)) {
  New-Item -ItemType Directory -Path $StagingDir | Out-Null
}

if (Test-Path $PackagePath) {
  Remove-Item -LiteralPath $PackagePath -Force
}

Write-Step "Packaging workspace"
Push-Location $RepoRoot
try {
  Invoke-CheckedCommand -FilePath "tar.exe" -ArgumentList @(
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=.deploy",
    "--exclude=.runtime",
    "--exclude=.state",
    "--exclude=generated",
    "--exclude=.codex-feishu-attachments",
    "--exclude=sessions.json",
    "--exclude=*.log",
    "-czf",
    $PackagePath,
    "."
  )
} finally {
  Pop-Location
}

$sshCommonArgs = @(
  "-i", $PrivateKeyPath,
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new"
)

$remoteArchivePath = "$RemoteTmpBase/codex-feishu-bridge-cloud.tar.gz"
$remoteScriptPath = "$RemoteTmpBase/codex-feishu-bridge-deploy.sh"
$remoteScriptLocalPath = Join-Path $StagingDir "codex-feishu-bridge-deploy.sh"
$remoteScriptContent = New-RemoteShellScript -RemoteAppDir $RemoteAppDir -RunInstall:(-not $SkipInstall) -RunTests:(-not $SkipTests) -RunRestart:(-not $SkipRestart)
[System.IO.File]::WriteAllText(
  $remoteScriptLocalPath,
  $remoteScriptContent,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Step "Uploading package"
Invoke-CheckedCommand -FilePath "scp.exe" -ArgumentList ($sshCommonArgs + @($PackagePath, "${UserName}@${HostName}:$remoteArchivePath"))

Write-Step "Uploading remote deploy helper"
Invoke-CheckedCommand -FilePath "scp.exe" -ArgumentList ($sshCommonArgs + @($remoteScriptLocalPath, "${UserName}@${HostName}:$remoteScriptPath"))

Write-Step "Extracting package on cloud"
Invoke-CheckedCommand -FilePath "ssh.exe" -ArgumentList ($sshCommonArgs + @(
  "${UserName}@${HostName}",
  "mkdir -p '$RemoteAppDir' && tar -xzf '$remoteArchivePath' -C '$RemoteAppDir' && chmod +x '$remoteScriptPath'"
))

Write-Step "Running cloud deploy"
Invoke-CheckedCommand -FilePath "ssh.exe" -ArgumentList ($sshCommonArgs + @(
  "${UserName}@${HostName}",
  "bash '$remoteScriptPath'"
))

Write-Step "Cleaning remote temp files"
Invoke-CheckedCommand -FilePath "ssh.exe" -ArgumentList ($sshCommonArgs + @(
  "${UserName}@${HostName}",
  "rm -f '$remoteArchivePath' '$remoteScriptPath'"
))

Write-Step "Cloud deploy complete"
Write-Host "Host: $HostName"
Write-Host "App:  $RemoteAppDir"
