/**
 * 代码仓库采集（对应 Python Core ingest/code.py，FR-14 代码类）。
 *
 * 插件内能做的（不下载整包，避免把 GB 级依赖拖进 vault）：
 *  1) GitHub / Gitee API 取仓库元数据（描述、语言、star、license、默认分支、topics）；
 *  2) 拉取 README 原文并截取，作为笔记正文（这是「理解项目」最有效的材料）；
 *  3) 语言分布统计（GitHub /languages 接口）；
 *  4) 如需完整源码归档，委托 Python Core 执行多镜像下载 + sha256 校验 + 断点续传。
 *
 * 降级契约：API 限流（未认证 60 次/小时）或私有仓库时，降级为「登记仓库链接 + 提示授权方式」，
 * 不丢入口信息、不报错中断。
 */
import type { CoreConfig } from "../config";
import type { Store } from "../store";
import type { HttpClient } from "../providers/base";
import { captureText } from "../capture";
import {
  fetchJson, fetchText, infoSection, IngestError, NOOP_PROGRESS, resourceDir,
  sections, type IngestResult, type ProgressFn,
} from "./common";

/** 解析仓库链接 → { host, owner, repo, ref }。 */
export function parseRepo(url: string): { host: string; owner: string; repo: string; ref: string } {
  const m =
    /codeload\.github\.com\/([^/]+)\/([^/]+)\/zip\/refs\/heads\/([\w.\-]+)/i.exec(url) ??
    /github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|archive)\/(?:refs\/heads\/)?([\w.\-]+))?\/?$/i.exec(url) ??
    /gitee\.com\/([^/]+)\/([^/?#]+?)(?:\/(?:tree)\/([\w.\-]+))?\/?$/i.exec(url) ??
    /gitlab\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(url);
  if (!m) {
    throw new IngestError(
      `无法识别的仓库链接：${url}\n` +
      "支持 github.com/owner/repo、gitee.com/owner/repo、gitlab.com/owner/repo 以及 codeload zip 链接。",
    );
  }
  const host = /gitee/i.test(url) ? "gitee" : /gitlab/i.test(url) ? "gitlab" : "github";
  return { host, owner: m[1], repo: m[2], ref: m[3] ?? "" };
}

interface RepoMeta {
  full_name: string;
  description: string;
  language: string;
  stars: number;
  forks: number;
  topics: string[];
  license: string;
  default_branch: string;
  homepage: string;
  updated_at: string;
  size_kb: number;
  archived: boolean;
}

export interface IngestCodeOptions {
  tags?: string[];
  /** 委托 Core：Core 在线时执行完整源码下载 + sha256 校验。 */
  delegate?: (url: string) => Promise<IngestResult | null>;
  /** 是否尝试拉取 README（默认 true）。 */
  fetchReadme?: boolean;
}

/**
 * 采集代码仓库。
 * 说明：不在此处下载 zip —— 插件内无法做多镜像测速/断点续传/sha256 校验，
 * 而且几 GB 的仓库写入 vault 会拖垮同步；这些能力由 Python Core 承担（见 README P4）。
 */
export async function ingestCode(
  store: Store,
  cfg: CoreConfig,
  http: HttpClient,
  source: string,
  opts: IngestCodeOptions = {},
  progress: ProgressFn = NOOP_PROGRESS,
): Promise<IngestResult> {
  const warnings: string[] = [];
  const { host, owner, repo, ref } = parseRepo(source);
  progress("获取仓库元数据…");

  let meta: RepoMeta | null = null;
  if (host === "github") {
    try {
      meta = await fetchJson<RepoMeta>(http, `https://api.github.com/repos/${owner}/${repo}`, 30000);
    } catch (e) {
      warnings.push(
        `GitHub 元数据获取失败（可能是未认证限流 60 次/小时，或仓库不存在/私有）：${String(e)}`,
      );
    }
  } else {
    warnings.push(`暂不支持 ${host} 的元数据解析，仅登记仓库链接`);
  }

  const title = meta?.full_name ? `代码库：${meta.full_name}` : `代码库：${owner}/${repo}`;
  const branch = ref || meta?.default_branch || "main";

  // README 是理解项目最有价值的材料，单独抓取
  let readme = "";
  if (opts.fetchReadme !== false && host === "github") {
    progress("获取 README…");
    for (const name of ["README.md", "readme.md", "README.rst", "README.txt"]) {
      try {
        const r = await fetchText(http, `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${name}`, { timeoutMs: 20000 });
        if (r.status >= 200 && r.status < 300 && r.text.trim()) {
          readme = r.text;
          break;
        }
      } catch {
        /* 逐个尝试，全部失败则跳过 */
      }
    }
    if (!readme) warnings.push(`未能获取 README（分支 ${branch} 上可能不存在，或仓库为私有）`);
  }

  // 语言分布
  let languages: Record<string, number> = {};
  if (host === "github" && meta) {
    try {
      languages = await fetchJson<Record<string, number>>(
        http, `https://api.github.com/repos/${owner}/${repo}/languages`, 20000,
      );
    } catch {
      warnings.push("语言分布获取失败（接口限流）");
    }
  }
  const langTotal = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  const langLine = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k} ${((v / langTotal) * 100).toFixed(1)}%`)
    .join("、");

  // 委托 Core（完整下载 + 校验）
  if (opts.delegate) {
    progress("检测到 Python Core，尝试委托完整源码归档…");
    try {
      const delegated = await opts.delegate(source);
      if (delegated) return delegated;
    } catch (e) {
      warnings.push(`委托 Core 归档失败，已降级为元数据采集：${String(e)}`);
    }
  }

  const dir = resourceDir(cfg, "code", `${owner}-${repo}`);
  // 把 README 原文归档（原件只增不改）
  if (readme) {
    try {
      await store.fs.write(`${dir}/README.md`, readme);
    } catch (e) {
      warnings.push(`README 归档失败：${String(e)}`);
    }
  }

  const overview = sections("项目概况", [
    meta?.description ? `- **简介**：${meta.description}` : "",
    meta?.language ? `- **主语言**：${meta.language}` : "",
    langLine ? `- **语言分布**：${langLine}` : "",
    meta ? `- **Star / Fork**：${meta.stars} / ${meta.forks}` : "",
    meta?.license ? `- **License**：${meta.license}` : "",
    meta?.topics?.length ? `- **Topics**：${meta.topics.join("、")}` : "",
    meta ? `- **体积**：约 ${(meta.size_kb / 1024).toFixed(1)} MB（未下载）` : "",
    meta?.archived ? "- **已归档（archived）**" : "",
    meta?.homepage ? `- **主页**：${meta.homepage}` : "",
  ].filter(Boolean).join("\n"));

  const content = readme
    ? readme.slice(0, 20000)
    : `（未获取到 README）仓库：${owner}/${repo}\n${meta?.description ?? ""}`;

  const cap = await captureText(store, cfg, {
    content,
    title,
    source_uri: source,
    tags: ["ingest/code", ...(meta?.topics?.slice(0, 5) ?? []), ...(opts.tags ?? [])],
    kind: "code",
    properties: {
      ingest_kind: "code",
      resources_dir: dir,
      repo: meta?.full_name ?? `${owner}/${repo}`,
      branch,
      language: meta?.language ?? "",
      stars: meta?.stars ?? 0,
      license: meta?.license ?? "",
      readme_path: readme ? `${dir}/README.md` : "",
      downloaded: false,
      processor: "pros-plugin/ingest/code",
      processor_version: "1.0.0",
      sections: [
        overview,
        infoSection([
          ["仓库地址", source],
          ["默认分支", branch],
          ["源码归档", "未下载（插件不做整包下载）；启用 Python Core 可多镜像下载 + sha256 校验"],
        ]),
      ],
      warnings,
    },
  });

  return {
    id: cap.id,
    kind: "code",
    kind_label: "代码",
    title,
    resources_dir: dir,
    warnings,
    delegated: false,
    needs_transcript: false,
  };
}
