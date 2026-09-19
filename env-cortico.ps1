# ---------------------------------------------------------------------------
# Workspace-local tool caches for the Cortico checkout.
#
# The DSH sandbox denies writes outside the session workspace, which is why
# plain `npm install` failed with EPERM: npm wanted to write its cache under
# %APPDATA%\npm. Redirecting every cache into .toolcache fixes it.
#
# NOTE: this file is intentionally ASCII-only and derives the workspace root
# from its own location ($PSScriptRoot), so no non-ASCII path is hardcoded.
# PowerShell 5.1 reads .ps1 as ANSI unless it has a BOM, so hardcoding a
# Chinese path here would be mis-decoded.
#
# Usage (from anywhere):
#     . D:\<workspace>\env-cortico.ps1
# ---------------------------------------------------------------------------

$root  = $PSScriptRoot
$cache = Join-Path $root '.toolcache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null

$env:COREPACK_HOME         = Join-Path $cache 'corepack'
$env:PNPM_HOME             = Join-Path $cache 'pnpm'
$env:npm_config_cache      = Join-Path $cache 'npm-cache'
$env:npm_config_store_dir  = Join-Path $cache 'pnpm-store'
$env:npm_config_prefix     = Join-Path $cache 'npm-global'
$env:npm_config_userconfig = Join-Path $cache 'npmrc'
$env:npm_config_fund       = 'false'
$env:npm_config_audit      = 'false'
$env:npm_config_update_notifier = 'false'
$env:GIT_CONFIG_GLOBAL     = Join-Path $cache 'gitconfig'
$env:GIT_CONFIG_NOSYSTEM   = '1'
$env:PYTHONIOENCODING      = 'utf-8'

# Non-interactive: background jobs must never block on an approval prompt.
$env:CI = 'true'
