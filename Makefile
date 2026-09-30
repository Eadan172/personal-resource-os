# 跨平台 Makefile：Windows / Linux / macOS 通用。
#
# 设计要点（P1）：
# - 不依赖 bash：E2E 改为纯 Python 脚本 e2e/run_e2e.py，Windows 无需 WSL/Git-Bash；
# - 自动适配命令与分隔符：Windows 用 python + ';'，POSIX 用 python3 + ':'；
# - 失败容忍用 GMake 内建的 '-' 前缀（而非 POSIX 的 `|| true`），cmd 与 sh 都可用。
#
# Windows 若未安装 GNU make，可直接使用等价入口 make.bat / make.ps1（见 README「Windows 快速开始」）。

ifeq ($(OS),Windows_NT)
  PATHSEP := ;
  PY := python
else
  PATHSEP := :
  PY := python3
endif

PYTHONPATH := core$(PATHSEP).
export PYTHONPATH

.DEFAULT_GOAL := help

.PHONY: help dev test e2e lint typecheck build backup restore clean

help:       ## 显示所有可用命令
	@echo Personal Resource OS — 可用命令：
	@echo   make dev        本地启动 API 服务（127.0.0.1:8765）
	@echo   make test       全量单元/集成测试（无网络、Mock 确定性）
	@echo   make e2e        闭环 E2E（跨平台，纯 Python）
	@echo   make lint       ruff 静态检查
	@echo   make typecheck  mypy 类型检查
	@echo   make build      构建 Docker 镜像
	@echo   make backup     备份到 ./backups
	@echo   make restore DIR=备份目录
	@echo Windows 无 make 时：make.bat ^<目标^> 或 .\make.ps1 ^<目标^>

dev:        ## 本地启动 API 服务（127.0.0.1:8765）
	$(PY) -m personal_agent_core.cli serve

test:       ## 全量测试（无网络、Mock Provider 确定性）
	$(PY) -m pytest tests/ -q -p no:cacheprovider

e2e:        ## 闭环 E2E：capture→process→search→ask→task→audit→rollback→summary→backup
	$(PY) e2e/run_e2e.py

lint:
	-$(PY) -m ruff check core mcp_gateway tests

typecheck:
	-$(PY) -m mypy core/personal_agent_core --ignore-missing-imports

build:
	docker build -t pros-core .

backup:
	$(PY) -m personal_agent_core.cli backup ./backups

restore:
	$(PY) -m personal_agent_core.cli restore $(DIR) --db ./data/pros.db

clean:
	-$(PY) -c "import shutil,pathlib; [shutil.rmtree(p, ignore_errors=True) for p in pathlib.Path('.').rglob('__pycache__')]"