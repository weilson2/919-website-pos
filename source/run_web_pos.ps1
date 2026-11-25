[CmdletBinding()]
param(
    [string]$DatabasePath = (Join-Path $PSScriptRoot "pos.db"),
    [string]$BackupDirectory = (Join-Path $PSScriptRoot "backups"),
    [string]$ListenAddress = "127.0.0.1",
    [ValidateRange(1, 65535)]
    [int]$Port = 8000,
    [switch]$AllowRemote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedDatabase = (Resolve-Path -LiteralPath $DatabasePath).Path
if (-not (Test-Path -LiteralPath $BackupDirectory)) {
    New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
}
$resolvedBackups = (Resolve-Path -LiteralPath $BackupDirectory).Path

$pythonExecutable = $env:POS_PYTHON_EXE
if (-not $pythonExecutable) {
    $venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) {
        $pythonExecutable = $venvPython
    } else {
        $pythonExecutable = (Get-Command python -ErrorAction Stop).Source
    }
}

if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    throw "Python executable not found: $pythonExecutable"
}

$loopbackNames = @("127.0.0.1", "::1", "localhost")
if ($ListenAddress -notin $loopbackNames -and -not $AllowRemote) {
    throw "A non-local address requires -AllowRemote. Configure a private network and Admin password hash first."
}

$env:POS_DB_PATH = $resolvedDatabase
$env:POS_BACKUP_DIR = $resolvedBackups
$env:POS_WEB_HOST = $ListenAddress
$env:POS_WEB_PORT = [string]$Port
if ($AllowRemote) {
    $env:POS_ALLOW_REMOTE = "1"
} else {
    Remove-Item Env:POS_ALLOW_REMOTE -ErrorAction SilentlyContinue
}

Push-Location $PSScriptRoot
try {
    & $pythonExecutable "web_server.py"
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
