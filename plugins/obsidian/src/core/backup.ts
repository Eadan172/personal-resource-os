/**
 * 导出 / 备份 / 恢复（对应 Python Core backup.py，FR-16 数据可携带）。
 *
 * - 导出：全量 JSON（含 schema_version），便于迁移到其它宿主或外部工具；
 * - 备份：索引库快照 + manifest（逐文件 SHA-256 清单）；
 * - 恢复：先校验 schema 版本与哈希，校验失败一律拒绝写入（防止半损坏库覆盖好数据）。
 */
import type { CoreConfig } from "./config";
import type { ProsDB } from "./models";
import type { Store } from "./store";
import { nowIso, sha256Text } from "./util";

export interface BackupManifest {
  created_at: string;
  schema_version: number;
  files: Record<string, string>;
  stats: { objects: number; tasks: number; relations: number; audit: number };
}

export interface BackupResult {
  backup_dir: string;
  manifest: BackupManifest;
}

/** 导出全量 JSON 到指定路径（vault 相对路径）。 */
export async function exportJson(store: Store, path: string): Promise<string> {
  await store.fs.write(path, store.exportJson());
  return path;
}

/** 创建备份：目录下写入 resource.db.json + manifest.json。 */
export async function backup(store: Store, cfg: CoreConfig, dir?: string): Promise<BackupResult> {
  const base = dir ?? `${cfg.baseDir}/backup`;
  const stamp = nowIso().replace(/[:.]/g, "-");
  const backupDir = `${base}/${stamp}`;
  const dbName = "resource.db.json";
  const dbText = JSON.stringify(store.db, null, 2);
  await store.fs.write(`${backupDir}/${dbName}`, dbText);

  const manifest: BackupManifest = {
    created_at: nowIso(),
    schema_version: store.db.schema_version,
    files: { [dbName]: sha256Text(dbText) },
    stats: {
      objects: store.objects.length,
      tasks: store.tasks.length,
      relations: store.relations.length,
      audit: store.db.audit_log.length,
    },
  };
  await store.fs.write(`${backupDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  return { backup_dir: backupDir, manifest };
}

/** 列出可用备份（按时间倒序）。返回**完整目录路径**，可直接传给 restore。 */
export async function listBackups(store: Store, cfg: CoreConfig, dir?: string): Promise<string[]> {
  const base = dir ?? `${cfg.baseDir}/backup`;
  if (!(await store.fs.exists(base))) return [];
  const listed = await store.fs.list(base);
  return listed.folders
    // pre-restore 是「恢复前快照」的容器目录，本身不是一次备份，避免出现在可选列表里
    .filter((f) => f !== "pre-restore")
    .sort()
    .reverse()
    .map((f) => `${base}/${f}`);
}

/**
 * 从备份恢复。任何校验失败都会抛错且不修改当前库。
 * @param target 可选：恢复到指定 Store（默认写回 store 自身）
 */
export async function restore(store: Store, backupDir: string): Promise<{ restored: boolean; stats: BackupManifest["stats"] }> {
  const manifestPath = `${backupDir}/manifest.json`;
  if (!(await store.fs.exists(manifestPath))) throw new Error(`备份缺少 manifest.json：${backupDir}`);
  const manifest = JSON.parse(await store.fs.read(manifestPath)) as BackupManifest;

  if (manifest.schema_version !== store.db.schema_version) {
    throw new Error(
      `备份 schema_version=${manifest.schema_version} 与当前 ${store.db.schema_version} 不兼容，已拒绝恢复`,
    );
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    const p = `${backupDir}/${name}`;
    if (!(await store.fs.exists(p))) throw new Error(`备份文件缺失：${name}`);
    const actual = sha256Text(await store.fs.read(p));
    if (actual !== digest) throw new Error(`备份文件 ${name} 哈希校验失败，已拒绝恢复（文件可能损坏）`);
  }

  const dbFile = Object.keys(manifest.files)[0];
  const restored = JSON.parse(await store.fs.read(`${backupDir}/${dbFile}`)) as ProsDB;

  // 校验通过后才替换内存库，并立即落盘
  store.db = restored;
  await store.flush();
  return { restored: true, stats: manifest.stats };
}

/** 生成恢复前的安全快照（避免“恢复即覆盖”不可逆）。 */
export async function snapshotBeforeRestore(store: Store, cfg: CoreConfig): Promise<string> {
  const r = await backup(store, cfg, `${cfg.baseDir}/backup/pre-restore`);
  return r.backup_dir;
}
