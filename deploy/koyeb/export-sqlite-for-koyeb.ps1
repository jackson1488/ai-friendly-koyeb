param(
  [string]$SourceBackendDir = "backend",
  [string]$OutputPath = "backups\forced\prod-for-koyeb.db"
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$backendDir = Join-Path $repoRoot $SourceBackendDir
$schemaPath = Join-Path $backendDir "prisma\schema.prisma"
$dbPath = Join-Path $backendDir "prisma\dev.db"
$outPath = Join-Path $repoRoot $OutputPath
$outDir = Split-Path -Parent $outPath

if (-not (Test-Path -LiteralPath $dbPath)) {
  Write-Error "SQLite database not found: $dbPath"
  exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$tempSql = Join-Path $env:TEMP "ai-friendly-sqlite-checkpoint.sql"
Set-Content -Path $tempSql -Value "PRAGMA wal_checkpoint(TRUNCATE);" -Encoding UTF8

Write-Host "Checkpointing SQLite WAL before copy..."
Push-Location $backendDir
try {
  npx prisma db execute --schema $schemaPath --file $tempSql
} catch {
  Write-Warning "Prisma checkpoint failed. Copying main db anyway. Stop backend first for the safest export. Error: $($_.Exception.Message)"
} finally {
  Pop-Location
}

Copy-Item -LiteralPath $dbPath -Destination $outPath -Force

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $outPath
Write-Host "Exported DB: $outPath"
Write-Host "SHA256: $($hash.Hash)"
Write-Host "Do not commit this file. Upload it to Koyeb volume as /data/prod.db or expose it through a temporary private HTTPS DATABASE_SEED_URL."
