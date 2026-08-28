//! 部署 opencode trace-logger 插件到 opencode 的全局插件目录。
//!
//! opencode 自动发现 `<config>/opencode/plugins/*.ts`，无需任何配置文件。部署是
//! 幂等的：目标文件头带版本戳与内容 hash，仅当内容变化时覆盖，所以每次激活
//! （包括升级后重启）都安全。
//!
//! 部署与读取的职责边界：本插件只负责把采集器放到 opencode 能找到的位置；
//! trace 文件本身由 opencode 进程写入，读取由 Ora 宿主代劳（session.trace 能力）。

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import traceLoggerSource from "../trace/opencode-trace-logger.ts" with {
  type: "text",
};
import { traceDir } from "../trace/opencode-trace-logger.ts";

/** 部署文件名：opencode 按文件名自动加载，且与用户自装插件不冲突。 */
const DEPLOY_FILE = "ora-trace-logger.ts";
/** 部署版本戳：随内容格式演进递增，旧版本文件会被覆盖。 */
const DEPLOY_VERSION = 1;
/** 清理保留策略的默认天数。 */
const DEFAULT_MAX_AGE_DAYS = 30;

/** opencode 全局插件目录（尊重 XDG_CONFIG_HOME）。 */
export function opencodePluginDir(): string {
  const config = process.env.XDG_CONFIG_HOME;
  const base = config && config.startsWith("/")
    ? config
    : join(homedir(), ".config");
  return join(base, "opencode", "plugins");
}

/** 一次部署的结果。 */
export interface DeployResult {
  /** 部署到的绝对路径。 */
  path: string;
  /** 本次是否真正写了文件（内容与已部署版本不同）。 */
  changed: boolean;
}

/** 内容 hash：幂等判据，版本戳之外的第二重保险。 */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 部署采集器插件；已部署且内容未变时不动文件（幂等）。
 *
 * 默认部署到全局插件目录（决策：一次部署所有项目生效）。插件源码以内嵌文本
 * 随包分发，运行时无需读取仓库文件。
 */
export async function deployTraceLogger(
  opts: { targetDir?: string } = {},
): Promise<DeployResult> {
  const directory = opts.targetDir ?? opencodePluginDir();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, DEPLOY_FILE);

  const hash = await sha256(traceLoggerSource);
  const stamp = `// ora-trace-logger version=${DEPLOY_VERSION} hash=${hash}`;
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // 尚未部署：走覆盖分支。
  }
  if (existing.includes(stamp)) {
    return { path, changed: false };
  }

  writeFileSync(path, `${stamp}\n${traceLoggerSource}`, "utf8");
  return { path, changed: true };
}

/** 移除已部署的插件文件（卸载清理用）；文件不存在时静默。 */
export function removeTraceLogger(
  opts: { targetDir?: string } = {},
): void {
  const directory = opts.targetDir ?? opencodePluginDir();
  try {
    unlinkSync(join(directory, DEPLOY_FILE));
  } catch {
    // 不存在或不可写：卸载本身不应因此失败。
  }
}

/**
 * 清理 trace 目录中超过 `maxAgeDays` 天的会话文件，返回删除数量。
 *
 * 文件即持久层后需要有保留策略：opencode 侧由本插件在激活时顺手清理，
 * claude 侧由 Claude 自身管理。
 */
export function pruneOldTraces(
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
  opts: { traceDirectory?: string } = {},
): number {
  const directory = opts.traceDirectory ?? traceDir();
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".ndjson")) {
      continue;
    }
    const path = join(directory, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      // 单个文件失败不影响其余清理。
    }
  }
  return removed;
}
