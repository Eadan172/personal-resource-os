@echo off
rem ============================================================================
rem  Personal Resource OS - Windows CMD entry (no GNU make / bash required)
rem
rem  Usage (in the project root):
rem      make test         run all tests
rem      make e2e          end-to-end check (pure Python, no bash)
rem      make dev          start local API server (127.0.0.1:8765)
rem      make backup       back up to .\backups
rem
rem  cmd.exe searches the current directory for commands, so after this file sits
rem  in the project root you can simply type:  make e2e
rem ============================================================================
setlocal
rem Always run from the script directory (project root) so paths resolve correctly.
cd /d "%~dp0"

rem Cross-platform PYTHONPATH: Windows uses ';'
set "PYTHONPATH=core;."
rem Unbuffered Python output so progress/log lines appear in real time.
set "PYTHONUNBUFFERED=1"

set "PY=python"
set "CMD="

if "%~1"=="" goto :usage
if /i "%~1"=="test"      set "CMD=%PY% -m pytest tests/ -q -p no:cacheprovider"
if /i "%~1"=="e2e"       set "CMD=%PY% e2e\run_e2e.py"
if /i "%~1"=="dev"       set "CMD=%PY% -m personal_agent_core.cli serve"
if /i "%~1"=="lint"      set "CMD=%PY% -m ruff check core mcp_gateway tests"
if /i "%~1"=="typecheck" set "CMD=%PY% -m mypy core/personal_agent_core --ignore-missing-imports"
if /i "%~1"=="backup"    set "CMD=%PY% -m personal_agent_core.cli backup ./backups"
if defined CMD goto :run
echo Unknown target: %~1
goto :usage

:run
call %CMD%
exit /b %errorlevel%

:usage
echo Usage: make [test^|e2e^|dev^|lint^|typecheck^|backup]
exit /b 1