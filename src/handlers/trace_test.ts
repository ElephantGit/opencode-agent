//! 部署管理测试：幂等部署、移除、清理保留策略、目录约定。

import {
  deployTraceLogger,
  opencodePluginDir,
  pruneOldTraces,
  removeTraceLogger,
} from "./trace.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 抛出带上下文的失败。 */
function check(condition: boolean, context: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${context}`);
  }
}

Deno.test("opencodePluginDir 尊重 XDG_CONFIG_HOME", () => {
  const original = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", "/tmp/xdg-config");
    check(
      opencodePluginDir() === "/tmp/xdg-config/opencode/plugins",
      "XDG_CONFIG_HOME 优先",
    );
    Deno.env.delete("XDG_CONFIG_HOME");
    check(
      opencodePluginDir().endsWith("/.config/opencode/plugins"),
      "回退到 ~/.config",
    );
  } finally {
    if (original === undefined) {
      Deno.env.delete("XDG_CONFIG_HOME");
    } else {
      Deno.env.set("XDG_CONFIG_HOME", original);
    }
  }
});

Deno.test("部署幂等：内容未变不覆盖，内容变化才覆盖", async () => {
  const target = await Deno.makeTempDir();

  const first = await deployTraceLogger({ targetDir: target });
  check(first.changed, "首次部署必然写入");
  check(first.path.endsWith("ora-trace-logger.ts"), "部署文件名固定");
  const deployed = readFileSync(first.path, "utf8");
  check(
    deployed.includes("ora-trace-logger version=1 hash="),
    "文件头带版本戳",
  );

  const again = await deployTraceLogger({ targetDir: target });
  check(!again.changed, "内容未变时第二次部署不覆盖");

  // 篡改已部署文件（模拟用户编辑或旧版本残留）→ 下次部署应修复覆盖。
  writeFileSync(first.path, "// edited by hand\n", "utf8");
  const repaired = await deployTraceLogger({ targetDir: target });
  check(repaired.changed, "内容被篡改后部署会覆盖修复");
  check(
    readFileSync(first.path, "utf8").includes("ora-trace-logger version="),
    "覆盖后版本戳恢复",
  );

  removeTraceLogger({ targetDir: target });
  let exists = true;
  try {
    readFileSync(first.path);
  } catch {
    exists = false;
  }
  check(!exists, "removeTraceLogger 删除部署文件");
});

Deno.test("pruneOldTraces 只删超龄 ndjson", async () => {
  const target = await Deno.makeTempDir();
  const oldPath = join(target, "ses_old.ndjson");
  const newPath = join(target, "ses_new.ndjson");
  const otherPath = join(target, "readme.txt");
  writeFileSync(oldPath, "{}\n", "utf8");
  writeFileSync(newPath, "{}\n", "utf8");
  writeFileSync(otherPath, "not a trace\n", "utf8");

  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const fresh = new Date();
  Deno.utimeSync(oldPath, old, old);
  Deno.utimeSync(newPath, fresh, fresh);

  const removed = pruneOldTraces(30, { traceDirectory: target });
  check(removed === 1, `只删 1 个超龄文件，got ${removed}`);

  let oldExists = true;
  try {
    readFileSync(oldPath);
  } catch {
    oldExists = false;
  }
  check(!oldExists, "超龄 ndjson 已删除");
  check(readFileSync(newPath, "utf8") === "{}\n", "未超龄 ndjson 保留");
  check(readFileSync(otherPath, "utf8") === "not a trace\n", "非 ndjson 不动");

  // 目录不存在时静默返回 0。
  check(
    pruneOldTraces(30, { traceDirectory: join(target, "missing") }) === 0,
    "目录缺失返回 0",
  );
});
