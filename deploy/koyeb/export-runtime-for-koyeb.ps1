param(
  [string]$SourceProjectDir = "C:\Users\kenes\Desktop\ai_mental",
  [string]$OutputDir = "C:\Users\kenes\Desktop\ai_mental\backups\forced\koyeb-export"
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$sourceProject = Resolve-Path $SourceProjectDir
$backendDir = Join-Path $sourceProject "backend"
$schemaPath = Join-Path $backendDir "prisma\schema.prisma"
$dbPath = Join-Path $backendDir "prisma\dev.db"
$uploadsDir = Join-Path $backendDir "uploads"
$outDir = $OutputDir
$dbOut = Join-Path $outDir "prod-for-koyeb.db"
$uploadsOut = Join-Path $outDir "uploads.tar.gz"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not (Test-Path -LiteralPath $dbPath)) {
  Write-Error "SQLite database not found: $dbPath"
  exit 1
}

$tempSql = Join-Path $env:TEMP "ai-friendly-sqlite-checkpoint.sql"
Set-Content -Path $tempSql -Value "PRAGMA wal_checkpoint(TRUNCATE);" -Encoding UTF8

Write-Host "Checkpointing SQLite WAL before copy..."
Push-Location $backendDir
try {
  npx prisma db execute --schema $schemaPath --file $tempSql
} catch {
  Write-Warning "Prisma checkpoint failed. Stop backend first for the safest export. Error: $($_.Exception.Message)"
} finally {
  Pop-Location
}

Copy-Item -LiteralPath $dbPath -Destination $dbOut -Force

if (Test-Path -LiteralPath $uploadsDir) {
  if (Test-Path -LiteralPath $uploadsOut) {
    Remove-Item -LiteralPath $uploadsOut -Force
  }

  Push-Location $uploadsDir
  try {
    tar -czf $uploadsOut .
  } finally {
    Pop-Location
  }
} else {
  Write-Warning "Uploads folder not found: $uploadsDir"
}

$dbHash = Get-FileHash -Algorithm SHA256 -LiteralPath $dbOut
Write-Host "DB: $dbOut"
Write-Host "DB SHA256: $($dbHash.Hash)"

if (Test-Path -LiteralPath $uploadsOut) {
  $uploadsHash = Get-FileHash -Algorithm SHA256 -LiteralPath $uploadsOut
  Write-Host "Uploads: $uploadsOut"
  Write-Host "Uploads SHA256: $($uploadsHash.Hash)"
}

Write-Host "Do not commit these files. Use a temporary private tunnel or upload them directly to Koyeb volume."
