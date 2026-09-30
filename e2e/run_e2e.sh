#!/usr/bin/env bash
# 闭环 E2E：Capture → Inbox → AI 分类 → 持久化 → 检索 → 引用问答 → 建任务 → 审计 → 回滚
set -euo pipefail

# 跨平台：Windows（Git Bash / MSYS / Cygwin）下 Python 的 PYTHONPATH 用分号分隔，
# 且 Windows 通常只有 python 没有 python3。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows*) SEP=';' ;;
  *) SEP=':' ;;
esac
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

export PYTHONPATH="core${SEP}."
export PROS_DATA_DIR="$(mktemp -d)/data"
export PROS_PROVIDER=mock   # 无网络确定性

CLI="$PY -m personal_agent_core.cli"

echo "== 1. Capture =="
$CLI capture "待办：2026-10-20 之前完成季度复盘报告 #工作" > /dev/null
$CLI capture "与@李四讨论了新版定价策略，风险：老用户可能流失 #定价" > /dev/null

echo "== 2. Process（AI 整理 Inbox）=="
$CLI process | "$PY" -c "import json,sys; r=json.load(sys.stdin); assert all(x['status']=='processed' for x in r), r; print('processed:', len(r))"

echo "== 3. Search =="
$CLI search "定价策略" | "$PY" -c "import json,sys; r=json.load(sys.stdin); assert r and 'span' in r[0]; print('hits:', len(r))"

echo "== 4. Ask（带引用）=="
$CLI ask "定价策略有什么风险" | "$PY" -c "
import json,sys; r=json.load(sys.stdin)
assert r['citations'], '必须有引用'
print('citations:', len(r['citations']))"

echo "== 5. 无证据拒答 =="
$CLI ask "火星基地预算获批了吗" | "$PY" -c "
import json,sys; r=json.load(sys.stdin)
assert r['citations']==[] and '没有' in r['answer'] and '证据' in r['answer']; print('拒答正确')"

echo "== 6. Tasks（AI 自动创建）=="
$CLI tasks | "$PY" -c "import json,sys; r=json.load(sys.stdin); assert any(t['created_by_agent']==1 for t in r); print('tasks:', len(r))"

echo "== 7. Audit =="
AUDIT_ID=$($CLI audit --limit 200 | "$PY" -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
echo "latest audit: $AUDIT_ID"

echo "== 8. Rollback（回滚最近一条审计）=="
$CLI rollback "$AUDIT_ID" > /dev/null && echo "rollback ok"

echo "== 9. Summary =="
$CLI summary --start 2000-01-01 --end 2100-01-01 | "$PY" -c "
import json,sys; r=json.load(sys.stdin)
for k in ('what_happened','themes','completed','pending','risks','next_actions'): assert k in r
print('summary ok')"

echo "== 10. Backup =="
$CLI backup "$PROS_DATA_DIR/backups" > /dev/null && echo "backup ok"

echo "E2E 全部通过 ✅"
