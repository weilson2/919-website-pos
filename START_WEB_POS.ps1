[CmdletBinding()]
param(
    [string]$ListenAddress = "127.0.0.1",
    [ValidateRange(1, 65535)]
    [int]$Port = 8000,
    [switch]$AllowRemote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$sourceDirectory = Join-Path $PSScriptRoot "source"
$launcher = Join-Path $sourceDirectory "run_web_pos.ps1"
$restaurantDirectory = Split-Path $PSScriptRoot -Parent
$database = Join-Path $restaurantDirectory "Desktop POS\app\pos.db"
$backups = Join-Path $restaurantDirectory "Desktop POS\Backups"

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Website launcher not found: $launcher"
}
if (-not (Test-Path -LiteralPath $database)) {
    throw "Shared database not found: $database"
}

& $launcher `
    -DatabasePath $database `
    -BackupDirectory $backups `
    -ListenAddress $ListenAddress `
    -Port $Port `
    -AllowRemote:$AllowRemote

