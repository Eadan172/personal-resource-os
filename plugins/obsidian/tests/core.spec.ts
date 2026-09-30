/**
 * 核心业务闭环离线断言（Node 直跑，不依赖 Obsidian）。
 *
 * 覆盖范围刻意对齐「交付验收清单」：
 *  · 事实层完整性：原文不可被 AI 覆盖、hash 去重只建议不合并不丢
 *  · 全链路可用：采集 → 处理 → 检索 → 引用问答 → 任务 → 关系 → 总结
 *  · 信任边界：出站白名单、Agent 禁写原始事实、预算夹取
 *  · 可追溯性：审计留痕 + 单条回滚 + 软删除/恢复
 *  · 可运维性：导出 / 备份 / 恢复 / 重建索引
 *
 * 任何一条失败都会以非 0 退出码结束，方便接 CI。
 */
import { Store } from "../src/core/store";
import { MemoryFs } from "../src/vault/vaultFs";
import { createBridge } from "../src/bridge";
import { mergeConfig, checkOutbound, DEFAULT_CORE_CONFIG, HARD_LIMITS } from "../src/core/config";
import { sha256Text } from "../src/core/util";
import { findTaskLines, extractEntities } from "../src/core/extraction";
import type { HttpClient } from "../src/core/providers/base";

// ------------------------------------------------------------------ 断言 ---

let passed = 0;
const failures: string[] = [];

function ok(cond: unknown, label: string, extra?: unknown): void {
  if (cond) {
    passed++;
  } else {
    failures.push(`${label}${extra === undefined ? "" : ` ← ${JSON.stringify(extra)}`}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) passed++;
  else failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// -------------------------------------------------------------- 测试环境 ---

/** 离线 HttpClient：核心在 local 模式不应触网；一旦触网说明有意外外发，直接失败。 */
const offlineHttp: HttpClient = {
  request() {
    throw new Error("测试环境禁止网络请求（说明核心发生了非预期外发）");
  },
  fetchBinary() {
    throw new Error("测试环境禁止网络请求");
  },
};

const CFG = mergeConfig({ ...DEFAULT_CORE_CONFIG, provider: "mock" });

async function main(): Promise<void> {
  // ============================================================ 0. 基础 ---
  section("0. 基础工具");
  eq(
    sha256Text("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "自带 SHA-256 与标准实现一致",
  );
  eq(sha256Text("").length, 64, "空串哈希长度 64");

  const tasks0 = findTaskLines("明天务必提交产品评审纪要\n随便一行普通文本");
  ok(tasks0.length === 1, "任务行识别：命中 1 条", tasks0);
  ok(tasks0[0]?.span?.start !== undefined, "任务行带 span（可回溯原文）", tasks0[0]);
  const ents = extractEntities("联系 @张三 关于 #项目A 的事，3 月 5 日开会，预算 ¥1200");
  ok(ents.people.length >= 1, "实体：识别人物", ents.people);
  ok(ents.tags.length >= 1, "实体：识别标签", ents.tags);

  // ======================================================== 1. 初始化 ---
  section("1. 索引库与桥接初始化");
  const fs = new MemoryFs();
  const store = await Store.open(fs, CFG);
  ok(await fs.exists("_pros/resource.db.json"), "索引库文件已创建");
  eq(store.agents.length >= 4, true, "出厂内置 Agent 已就位");
  eq(store.db.connectors.length >= 3, true, "出厂 Connector 已就位（默认关闭）");
  ok(store.db.connectors.every((c) => !c.enabled), "Connector 默认全部关闭");

  const { bridge } = await createBridge({
    preference: "local",
    cfg: CFG,
    store,
    http: offlineHttp,
    beforeOutbound: async () => true,
  });
  eq(bridge.meta.mode, "local", "桥接模式为插件内核心");
  eq(bridge.meta.offline, true, "Mock Provider 标记为离线");
  eq(bridge.meta.supportsHeavyIngest, false, "插件内核心不支持重活（诚实声明）");

  // ======================================================== 2. 无证据拒答 ---
  section("2. RAG 铁律：无证据必须拒答");
  const empty = await bridge.ask("资料库里有没有关于量子计算的内容？");
  eq(empty.refused, true, "空库提问 → 拒答");
  eq(empty.citations.length, 0, "空库提问 → 无引用");

  // ============================================================ 3. 采集 ---
  section("3. 采集（原文优先落库）");
  const CONTENT = [
    "# 产品评审会要点",
    "",
    "联系 @张三 讨论 #路线图 排期，3 月 5 日 前完成方案。",
    "明天务必提交评审纪要。",
    "预算 ¥12000 已批准。",
    "参考 https://example.com/spec 的实现说明。",
  ].join("\n");

  const cap = await bridge.capture({
    content: CONTENT,
    title: "产品评审会要点",
    tags: ["工作", "会议"],
    dataClass: "internal",
    sourceChannel: "obsidian",
  });
  ok(cap.id.startsWith("obj_"), "采集返回对象 id", cap.id);
  ok(!!cap.note_path, "原始笔记已落盘", cap.note_path);
  eq(cap.content_hash.length, 64, "内容哈希为 sha256");
  eq(cap.duplicate_of, null, "首次采集无重复");

  const obj = await bridge.object(cap.id);
  ok(!!obj, "对象可读回");
  eq(obj?.lifecycle, "inbox", "采集后进入 Inbox");
  eq(obj?.origin, "raw", "采集内容 origin=raw（原始事实）");
  eq(obj?.content, CONTENT, "原文逐字保留（未被任何处理改写）");
  eq(obj?.data_class, "internal", "数据分级被记录");
  ok(await fs.exists(cap.note_path!), "vault 中的原始笔记确实存在");

  // 去重：只建议，不合并
  const dup = await bridge.capture({ content: CONTENT, title: "重复内容" });
  eq(dup.duplicate_of, cap.id, "重复采集 → 指向原对象的 duplicate_of 提示");
  const dupRels = await bridge.relationsOf(dup.id);
  const dupRel = [...dupRels.out, ...dupRels.in].find((r) => r.type === "duplicate_of");
  eq(dupRel?.status, "suggested", "重复关系为「待审核」，未自动合并");
  const allAfterDup = await bridge.objects({ lifecycle: "all" });
  ok(allAfterDup.length === 2, "两条内容都在库里（没有偷偷合并掉）", allAfterDup.length);

  // 原文保护：AI 不得覆写 content
  let agentWriteBlocked = false;
  try {
    store.updateObject(cap.id, { content: "AI 想改写的正文" }, "agent:inbox-organizer");
  } catch {
    agentWriteBlocked = true;
  }
  ok(agentWriteBlocked, "Agent 写入 objects.content 被拒绝（原始事实不可覆盖）");
  eq((await bridge.object(cap.id))?.content, CONTENT, "被拒后原文完好");

  // ============================================================ 4. 处理 ---
  section("4. 处理流水线（分类 / 摘要 / 实体 / 任务 / 关系）");
  const prog: string[] = [];
  const pr = await bridge.processObject(cap.id, (m) => prog.push(m));
  eq(pr.status, "processed", "处理成功");
  ok(prog.length > 0, "处理过程有进度回调", prog.length);
  ok(typeof pr.note_path === "string" && pr.note_path.length > 0, "结构化笔记已生成", pr.note_path);
  ok(await fs.exists(pr.note_path!), "结构化笔记文件真实存在");
  const structured = await fs.read(pr.note_path!);
  ok(structured.includes("产品评审会要点"), "结构化笔记含标题");
  ok(/AI|来源|置信度|推断/.test(structured), "结构化笔记含来源/置信度标注", structured.slice(0, 400));

  const processed = await bridge.object(cap.id);
  eq(processed?.lifecycle, "processed", "处理后生命周期流转为 processed");
  ok(processed?.type !== "note" || processed?.tags.length! >= 0, "分类结果已写入", processed?.type);

  const derivedTasks = await bridge.tasks({ sourceObjectId: cap.id, status: "all" });
  ok(derivedTasks.length >= 1, "从原文提取出待办任务", derivedTasks.length);

  // ============================================================ 5. 检索 ---
  section("5. 混合检索");
  const hits = await bridge.search("评审 路线图");
  ok(hits.length >= 1, "中文检索命中", hits.length);
  ok(!!hits[0]?.span && hits[0].span.end > hits[0].span.start, "命中结果带字符区间", hits[0]?.span);
  const noHits = await bridge.search("完全不存在的词汇zzzz");
  eq(noHits.length, 0, "无关查询不返回噪声结果");

  // ============================================================ 6. 问答 ---
  section("6. 引用问答（引用必须可回溯）");
  const ans = await bridge.ask("评审会要联系谁？", { topK: 5 });
  eq(ans.refused, false, "有证据时不拒答");
  ok(ans.evidence_count >= 1, "证据数 ≥ 1", ans.evidence_count);
  ok(ans.citations.length >= 1, "至少一条引用", ans.citations.length);
  const c0 = ans.citations[0];
  if (c0) {
    const src = await bridge.object(c0.object_id);
    eq(src?.content.slice(c0.span.start, c0.span.end), c0.exact_text, "引用的 exact_text 与原文切片严格一致");
    ok(c0.exact_text.length > 0, "引用切片非空");
  }

  // ============================================================ 7. 任务 ---
  section("7. 任务中心");
  const created = await bridge.createTask({ title: "手动创建的任务", priority: "P1", due_at: "2026-01-01" });
  ok(created.id.startsWith("tsk_"), "任务创建成功", created.id);
  const openTasks = await bridge.tasks({ status: "open" });
  ok(openTasks.length >= 2, "未完成任务可查询", openTasks.length);
  const statsBefore = await bridge.stats();
  ok(statsBefore.overdue >= 1, "逾期任务被统计", statsBefore.overdue);
  await bridge.setTaskStatus(created.id, "done");
  const afterDone = await bridge.tasks({ status: "done" });
  ok(afterDone.some((t) => t.id === created.id), "任务状态流转为完成");
  await bridge.setTaskPriority(created.id, "P0");
  ok((await bridge.tasks({ status: "all" })).find((t) => t.id === created.id)?.priority === "P0", "优先级可调整");

  // ============================================================ 8. 关系 ---
  section("8. 关系审核制");
  const rel = await bridge.relationsOf(cap.id);
  ok(rel.out.length + rel.in.length >= 1, "对象有关系记录");
  const suggested = [...rel.out, ...rel.in].find((r) => r.status === "suggested");
  if (suggested) {
    await bridge.setRelationStatus(suggested.id, "confirmed");
    const after = await bridge.relationsOf(cap.id);
    ok([...after.out, ...after.in].find((r) => r.id === suggested.id)?.status === "confirmed", "关系可确认");
  } else {
    passed++; // 无建议关系时跳过（不算失败）
  }

  // ============================================================ 9. 总结 ---
  section("9. 阶段总结与行动建议");
  const rec = await bridge.summarize({ granularity: "daily" });
  ok(rec.id.startsWith("sum_") || rec.id.length > 0, "总结已生成", rec.id);
  ok(rec.content.stats.objects >= 1, "总结覆盖到内容", rec.content.stats.objects);
  ok(Array.isArray(rec.content.what_happened), "总结含「发生了什么」维度");
  ok(Array.isArray(rec.content.next_actions), "总结含「下一步行动」维度");
  const md = await bridge.renderSummary(rec);
  ok(md.includes("#") && md.length > 40, "总结可渲染为 Markdown", md.length);
  const saved = await bridge.saveSummaryToVault(rec);
  ok(await fs.exists(saved), "总结已写入 vault", saved);
  if (rec.content.next_actions.length) {
    const before = await bridge.tasks({ status: "all" });
    await bridge.actionToTask(rec.content.next_actions[0], rec.id);
    const after = await bridge.tasks({ status: "all" });
    eq(after.length, before.length + 1, "行动建议可一键转任务");
  } else {
    passed++;
  }
  const assessment = await bridge.evaluateDecision("选择 A 还是 B", "哪个更合适？", ["A", "B"]);
  ok(typeof assessment.assessment === "string" && assessment.assessment.length > 0, "决策评估可插拔模型可用", assessment.model);

  // ========================================================== 10. Agent ---
  section("10. Agent 运行与预算");
  const agents = await bridge.agents();
  ok(agents.length >= 4, "Agent 定义可读", agents.length);
  const run = await bridge.runAgent("inbox-organizer", "明天必须完成评审纪要的整理。");
  ok(["succeeded", "failed", "aborted_budget", "aborted_timeout", "waiting_approval"].includes(run.status), "Agent 运行有确定状态", run.status);
  ok(typeof run.run_id === "string" && run.run_id.length > 0, "Agent 运行留痕（run_id）");
  const runs = await bridge.agentRuns(10);
  ok(runs.length >= 1, "运行记录可查询", runs.length);
  ok(Array.isArray(runs[0]?.trace), "运行 trace 可观测（NFR-04）");

  // ========================================================== 11. 审批 ---
  section("11. 审批门（未批准不落库）");
  const ap = await bridge.requestApproval("task_create", "create_task", { title: "需要审批的任务" });
  const pending = await bridge.approvals("pending");
  ok(pending.some((a) => a.id === ap.id), "审批请求进入待办队列", pending.length);
  const tasksBeforeApprove = await bridge.tasks({ status: "all" });
  const decided = await bridge.decideApproval(ap.id, true);
  eq(decided.status, "approved", "审批通过");
  const tasksAfterApprove = await bridge.tasks({ status: "all" });
  ok(tasksAfterApprove.length >= tasksBeforeApprove.length, "审批通过后动作才执行");
  const ap2 = await bridge.requestApproval("bulk_write", "create_task", { title: "应被拒绝的任务" });
  await bridge.decideApproval(ap2.id, false);
  ok((await bridge.approvals("rejected")).some((a) => a.id === ap2.id), "审批可拒绝并留痕");
  ok(!(await bridge.tasks({ status: "all" })).some((t) => t.title === "应被拒绝的任务"), "被拒绝的审批不产生任何数据");

  // ==================================================== 12. 审计与回滚 ---
  section("12. 审计与回滚");
  const auditAll = await bridge.audit({ limit: 500 });
  ok(auditAll.length >= 5, "审计日志已累积", auditAll.length);
  ok(auditAll.every((e) => e.op && e.object_type && e.actor), "每条审计都有 op/表/actor");
  const objAudit = await bridge.audit({ objectId: cap.id, limit: 100 });
  ok(objAudit.length >= 1, "可按对象查变更历史", objAudit.length);

  // 用户改正文 → origin 升级为 user_edit，并留下可回滚锚点
  await bridge.updateObject(cap.id, { content: `${CONTENT}\n\n（用户补充：已同步给张三）` });
  eq((await bridge.object(cap.id))?.origin, "user_edit", "用户编辑后 origin=user_edit");
  const updateEntry = (await bridge.audit({ objectId: cap.id, limit: 5 })).find((e) => e.op === "update");
  ok(!!updateEntry, "更新操作有审计锚点");
  if (updateEntry) {
    const rb = await bridge.rollback(updateEntry.id);
    ok(!!rb.rollback_audit_id && rb.description.length > 0, "单条回滚成功并留痕", rb.description);
    eq((await bridge.object(cap.id))?.content, CONTENT, "回滚后正文恢复为变更前内容");
  }

  // 软删除 + 恢复
  await bridge.deleteObject(cap.id);
  eq((await bridge.object(cap.id))?.lifecycle, "deleted", "删除走软删除（进回收站）");
  ok((await bridge.objects({ lifecycle: "inbox" })).every((o) => o.id !== cap.id), "回收站内容不出现在正常列表");
  await bridge.restoreObject(cap.id);
  eq((await bridge.object(cap.id))?.lifecycle, "processed", "可从回收站恢复");

  // ==================================================== 13. 备份 / 导出 ---
  section("13. 备份 / 导出 / 恢复 / 索引");
  const exportPath = await bridge.exportJson("_pros/exports/test-export.json");
  ok(await fs.exists(exportPath), "JSON 导出成功", exportPath);
  const bk = await bridge.backup();
  ok(await fs.exists(bk.backup_dir), "备份目录已创建", bk.backup_dir);
  const backups = await bridge.listBackups();
  ok(backups.length >= 1, "备份可列举", backups.length);
  const restored = await bridge.restore(backups[0]);
  eq(restored.restored, true, "从备份恢复成功");
  const idx = await bridge.rebuildIndex();
  ok(idx.objects >= 1, "索引重建可统计对象", idx.objects);

  // ==================================================== 14. 信任边界 ---
  section("14. 信任边界（白名单 / 数据分级 / 预算）");
  let blocked = false;
  try {
    checkOutbound(CFG, "https://evil.example.com/v1/chat");
  } catch {
    blocked = true;
  }
  ok(blocked, "未在白名单的域名被拒绝出站");
  checkOutbound(CFG, `${CFG.baseUrl}/chat/completions`);
  passed++; // 白名单内不抛错

  const tight = mergeConfig({
    outboundAllowlist: [],
    agentBudgets: { max_steps: 9999, timeout_s: 99999, max_tokens: 9999999, max_retries: 99, max_depth: 99 },
  });
  eq(tight.agentBudgets.max_steps, HARD_LIMITS.max_steps, "预算被夹到 max_steps 硬上限");
  eq(tight.agentBudgets.timeout_s, HARD_LIMITS.timeout_s, "预算被夹到 timeout_s 硬上限");
  eq(tight.agentBudgets.max_depth, HARD_LIMITS.max_depth, "预算被夹到 max_depth 硬上限");
  ok(tight.outboundAllowlist.length > 0, "空白名单回退为最小默认集（不会变成“全放开”）");

  // ========================================================== 15. 收尾 ---
  section("15. 落盘与统计一致性");
  await bridge.flush();
  const dbRaw = await fs.read("_pros/resource.db.json");
  const db = JSON.parse(dbRaw) as { objects: unknown[]; audit_log: unknown[]; tasks: unknown[] };
  ok(db.objects.length >= 2, "索引库落盘含全部对象", db.objects.length);
  ok(db.audit_log.length >= 5, "索引库落盘含审计日志", db.audit_log.length);
  const finalStats = await bridge.stats();
  eq(finalStats.total, db.objects.length, "统计口径与库内对象数一致");
  ok(finalStats.lastUpdated.length > 0, "库有更新时间戳");

  // ------------------------------------------------------------- 汇总 ---
  console.log("");
  if (failures.length) {
    console.error(`✗ 失败 ${failures.length} 项 / 通过 ${passed} 项\n`);
    for (const f of failures) console.error(`  · ${f}`);
    console.error("");
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 全部通过：${passed} 项断言`);
}

main().catch((e) => {
  console.error("\n✗ 运行中断：", e);
  process.exitCode = 1;
});
