#!/usr/bin/env pwsh
<#
  Personal Resource OS - Windows PowerShell entry (no GNU make / bash required).

  Usage (in the project root):
      .\make.ps1 test      run all tests
      .\make.ps1 e2e       end-to-end check (pure Python, no bash)
      .\make.ps1 dev       start local API server

  To type `make test` directly (like on Linux), add the project root to PATH:
      $env:PATH = "$PWD;$env:PATH"    # then: make test / make e2e
#>
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# Cross-platform PYTHONPATH: Windows uses ';'
$env:PYTHONPATH = "core;."
$env:PYTHONUNBUFFERED = "1"

$target = if ($args.Count -ge 1) { $args[0] } else { "help" }

$commands = @{
  "test"      = { python -m pytest tests/ -q -p no:cacheprovider }
  "e2e"       = { python e2e/run_e2e.py }
  "dev"       = { python -m personal_agent_core.cli serve }
  "lint"      = { python -m ruff check core mcp_gateway tests }
  "typecheck" = { python -m mypy core/personal_agent_core --ignore-missing-imports }
  "backup"    = { python -m personal_agent_core.cli backup ./backups }
}

if (-not $commands.ContainsKey($target)) {
  Write-Host "Usage: .\make.ps1 [test|e2e|dev|lint|typecheck|backup]"
  if ($target -ne "help") { exit 1 }
  exit 0
}

& $commands[$target]
exit $LASTEXITCODE