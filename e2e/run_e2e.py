#!/usr/bin/env python
"""闭环 E2E（跨平台，纯 Python，零 shell 依赖）。

流程：Capture → Process → Search → Ask(引用) → 无证据拒答 → Tasks → Audit → Rollback → Summary → Backup

用法（Windows CMD / PowerShell / Linux / macOS 通用）：
    python e2e/run_e2e.py
等价于 `make e2e`。不依赖 bash / GNU make，也不需要预先设置 PYTHONPATH：
脚本内部自动按当前操作系统拼接 PYTHONPATH（Windows 用 `;`，其它用 `:`）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable or "python"


def _env(data_dir: Path) -> dict:
    env = dict(os.environ)
    # 跨平台路径分隔符：os.pathsep 在 Windows 是 ';'，在 POSIX 是 ':'。
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT / "core"), str(ROOT)])
    env["PROS_DATA_DIR"] = str(data_dir)
    env["PROS_PROVIDER"] = "mock"          # 无网络确定性
    env["PYTHONIOENCODING"] = "utf-8"      # Windows 控制台默认 GBK，避免中文乱码
    return env


def cli(args: list[str], env: dict) -> object:
    """运行 CLI 子命令并返回解析后的 JSON（无输出则为 None）。"""
    proc = subprocess.run(
        [PY, "-m", "personal_agent_core.cli", *args],
        cwd=str(ROOT), env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"命令失败: cli {' '.join(args)}\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
    out = proc.stdout.strip()
    return json.loads(out) if out else None


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp) / "data"
        env = _env(data)

        print("== 1. Capture ==")
        cli(["capture", "待办：2026-10-20 之前完成季度复盘报告 #工作"], env)
        cli(["capture", "与@李四讨论了新版定价策略，风险：老用户可能流失 #定价"], env)

        print("== 2. Process（AI 整理 Inbox）==")
        r = cli(["process"], env)
        assert r and all(x["status"] == "processed" for x in r), r
        print("processed:", len(r))

        print("== 3. Search ==")
        r = cli(["search", "定价策略"], env)
        assert r and "span" in r[0], r
        print("hits:", len(r))

        print("== 4. Ask（带引用）==")
        r = cli(["ask", "定价策略有什么风险"], env)
        assert r["citations"], "必须有引用"
        print("citations:", len(r["citations"]))

        print("== 5. 无证据拒答 ==")
        r = cli(["ask", "火星基地预算获批了吗"], env)
        assert r["citations"] == [] and "没有" in r["answer"] and "证据" in r["answer"], r
        print("拒答正确")

        print("== 6. Tasks（AI 自动创建）==")
        r = cli(["tasks"], env)
        assert any(t["created_by_agent"] == 1 for t in r), r
        print("tasks:", len(r))

        print("== 7. Audit ==")
        audit_rows = cli(["audit", "--limit", "200"], env)
        audit_id = audit_rows[0]["id"]
        print("latest audit:", audit_id)

        print("== 8. Rollback（回滚最近一条审计）==")
        cli(["rollback", audit_id], env)
        print("rollback ok")

        print("== 9. Summary ==")
        r = cli(["summary", "--start", "2000-01-01", "--end", "2100-01-01"], env)
        for k in ("what_happened", "themes", "completed", "pending", "risks", "next_actions"):
            assert k in r
        print("summary ok")

        print("== 10. Backup ==")
        cli(["backup", str(data / "backups")], env)
        print("backup ok")

    print("\nE2E 全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())