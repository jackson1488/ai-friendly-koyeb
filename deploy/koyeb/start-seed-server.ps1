param(
  [string]$SeedDir = "backups\forced\koyeb-export",
  [int]$Port = 5055,
  [string]$Token = ""
)

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

if (-not $Token) {
  $Token = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
}

$env:SEED_DIR = (Resolve-Path $SeedDir).Path
$env:SEED_PORT = "$Port"
$env:SEED_TOKEN = $Token

Write-Host "Seed token for Koyeb env:"
Write-Host $Token
Write-Host ""
Write-Host "Start this server, then in another terminal run:"
Write-Host "cloudflared tunnel --url http://localhost:$Port"
Write-Host ""
Write-Host "Koyeb env example after cloudflared gives URL:"
Write-Host "DATABASE_SEED_URL=https://YOUR-TUNNEL.trycloudflare.com/prod-for-koyeb.db"
Write-Host "UPLOADS_SEED_URL=https://YOUR-TUNNEL.trycloudflare.com/uploads.tar.gz"
Write-Host "DATABASE_SEED_BEARER_TOKEN=$Token"
Write-Host "UPLOADS_SEED_BEARER_TOKEN=$Token"
Write-Host ""

node "$PSScriptRoot\start-seed-server.js"
