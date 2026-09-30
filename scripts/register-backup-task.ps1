# Supabase の毎日バックアップ（scripts/backup-supabase.mjs）を Windows のタスクスケジューラに登録する（2026-10-01）。
#
#   powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1 -BackupDir "G:\マイドライブ\ULL-backups"
#
# 毎日 3:00 に実行。PC が落ちていて逃した回は、次に起動したときに実行する（StartWhenAvailable）。
# ログは保存先の backup.log に追記。登録し直すときも同じコマンドでよい（上書き）。消すときは:
#   Unregister-ScheduledTask -TaskName "ULL Supabase Backup" -Confirm:$false
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [string]$Time = "03:00"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$log = Join-Path $BackupDir "backup.log"

$cmd = "`"$node`" `"$repo\scripts\backup-supabase.mjs`" `"$BackupDir`" >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $cmd" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ULL Supabase Backup" -Action $action -Trigger $trigger -Settings $settings -Description "ULL Studio の Supabase を毎日バックアップ（scripts/backup-supabase.mjs）" -Force | Out-Null

Write-Host "登録しました: 毎日 $Time に $BackupDir へ保存（ログ: $log）"
Write-Host "今すぐ 1 回試すなら: Start-ScheduledTask -TaskName 'ULL Supabase Backup'"
