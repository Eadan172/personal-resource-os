/**
 * 文件系统适配层（薄宿主的唯一落点）。
 *
 * 核心逻辑（src/core/**）只依赖本文件定义的 `VaultFs` 窄接口，不直接碰 Obsidian API，
 * 因此核心可以被 Node 脚本直接加载做离线断言（tests/run-tests.mjs）。
 * 两个实现：
 *  - ObsidianVaultFs：包装 `app.vault.adapter`，读写仅限 vault 内（TB-1 边界）；
 *  - MemoryFs：内存实现，供单元测试与 Node 断言使用。
 *
 * 目录约定（对应 docs E.3 文件布局，全部位于用户配置的工作目录下）：
 *   <base>/resource.db.json          单文件索引库（对象/关系/任务/审计/审批/总结）
 *   <base>/resources/<kind>/<id>-x/  采集原件 + note.md + derived
 *   <base>/exports/                  JSON 导出
 *   <base>/backup/                   备份
 * 笔记本身写入 vault 的 inbox/ notes/ projects/ people/ meetings/（Obsidian 可直接浏览）。
 */

/** 只读目录列表结果（与 Obsidian ListedFiles 对齐）。 */
export interface ListedFiles {
  files: string[];
  folders: string[];
}

export interface VaultFs {
  /** 路径是否存在（文件或目录）。 */
  exists(path: string): Promise<boolean>;
  /** 读取文本；不存在时抛错。 */
  read(path: string): Promise<string>;
  /** 写入文本（自动创建父目录）。 */
  write(path: string, data: string): Promise<void>;
  /** 读取二进制。 */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** 写入二进制（自动创建父目录）。 */
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  /** 递归创建目录。 */
  mkdir(path: string): Promise<void>;
  /** 列出目录内容。 */
  list(path: string): Promise<ListedFiles>;
  /** 删除文件或目录（不存在时不报错）。 */
  remove(path: string): Promise<void>;
  /** 重命名/移动。 */
  rename(from: string, to: string): Promise<void>;
  /** 文件大小（字节）；不存在返回 0。 */
  size(path: string): Promise<number>;
}

/** 保证父目录存在后再写入（Obsidian adapter.write 不会自动建目录）。 */
async function ensureParent(fs: VaultFs, path: string): Promise<void> {
  const parent = path.split("/").slice(0, -1).join("/");
  if (parent && !(await fs.exists(parent))) await fs.mkdir(parent);
}

/** Obsidian vault 适配器：所有路径都是 vault 相对路径，越界写入从设计上不可能发生。 */
export class ObsidianVaultFs implements VaultFs {
  private adapter: {
    exists(p: string): Promise<boolean>;
    read(p: string): Promise<string>;
    write(p: string, d: string): Promise<void>;
    readBinary(p: string): Promise<ArrayBuffer>;
    writeBinary(p: string, d: ArrayBuffer): Promise<void>;
    mkdir(p: string): Promise<void>;
    list(p: string): Promise<ListedFiles>;
    remove(p: string): Promise<void>;
    rename(f: string, t: string): Promise<void>;
    stat?(p: string): Promise<{ size: number } | null>;
  };

  constructor(adapter: unknown) {
    this.adapter = adapter as ObsidianVaultFs["adapter"];
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  read(path: string): Promise<string> {
    return this.adapter.read(path);
  }

  async write(path: string, data: string): Promise<void> {
    await ensureParent(this, path);
    await this.adapter.write(path, data);
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await ensureParent(this, path);
    await this.adapter.writeBinary(path, data);
  }

  mkdir(path: string): Promise<void> {
    // Obsidian 的 mkdir 已支持递归创建
    return this.adapter.mkdir(path);
  }

  list(path: string): Promise<ListedFiles> {
    return this.adapter.list(path);
  }

  async remove(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await ensureParent(this, to);
    await this.adapter.rename(from, to);
  }

  async size(path: string): Promise<number> {
    if (!this.adapter.stat) return 0;
    try {
      const st = await this.adapter.stat(path);
      return st?.size ?? 0;
    } catch {
      return 0;
    }
  }
}

/**
 * 内存文件系统：用于离线测试与 Node 断言（不依赖 Obsidian 运行时）。
 * 以 Map 保存路径 → 内容（文本或二进制）。
 */
export class MemoryFs implements VaultFs {
  private files = new Map<string, string | ArrayBuffer>();

  private static norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  }

  async exists(path: string): Promise<boolean> {
    const p = MemoryFs.norm(path);
    if (this.files.has(p)) return true;
    const prefix = p + "/";
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  async read(path: string): Promise<string> {
    const v = this.files.get(MemoryFs.norm(path));
    if (v === undefined) throw new Error(`文件不存在：${path}`);
    if (typeof v === "string") return v;
    return new TextDecoder().decode(v);
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(MemoryFs.norm(path), data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const v = this.files.get(MemoryFs.norm(path));
    if (v === undefined) throw new Error(`文件不存在：${path}`);
    if (typeof v === "string") return new TextEncoder().encode(v).buffer as ArrayBuffer;
    return v;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(MemoryFs.norm(path), data);
  }

  async mkdir(): Promise<void> {
    /* 内存实现无需真实目录 */
  }

  async list(path: string): Promise<ListedFiles> {
    const p = MemoryFs.norm(path);
    const prefix = p ? p + "/" : "";
    const files: string[] = [];
    const folders = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const idx = rest.indexOf("/");
      if (idx === -1) files.push(rest);
      else folders.add(rest.slice(0, idx));
    }
    return { files, folders: [...folders] };
  }

  async remove(path: string): Promise<void> {
    const p = MemoryFs.norm(path);
    this.files.delete(p);
    const prefix = p + "/";
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = MemoryFs.norm(from);
    const t = MemoryFs.norm(to);
    const v = this.files.get(f);
    if (v === undefined) throw new Error(`文件不存在：${from}`);
    this.files.delete(f);
    this.files.set(t, v);
  }

  async size(path: string): Promise<number> {
    const v = this.files.get(MemoryFs.norm(path));
    if (v === undefined) return 0;
    return typeof v === "string" ? new TextEncoder().encode(v).length : v.byteLength;
  }

  /** 测试用：导出全部路径。 */
  keys(): string[] {
    return [...this.files.keys()];
  }
}
