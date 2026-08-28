//! 移植对照测试：用合成 opencode bus 事件与 hooks 驱动 createTraceLogger 的注入出口，
//! 断言产出的 NDJSON 行与移植前 trace_logger.ts 的语义逐项一致。
//!
//! 不用断言库：保持仓库依赖最小，失败信息靠测试名与上下文字符串。

import type { Hooks } from "@opencode-ai/plugin";
import {
  createTraceLogger,
  traceDir,
  type TraceEmit,
} from "./opencode-trace-logger.ts";

/** 抛出带上下文的失败。 */
function check(condition: boolean, context: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${context}`);
  }
}

/** 一条被注入出口捕获的事件行（payload 未序列化前）。 */
interface Captured {
  sessionID: string;
  type: string;
  payload: Record<string, unknown>;
}

/** 建一个带捕获出口的插件实例（hooks 未触发前不产行）。 */
async function drive() {
  const lines: Captured[] = [];
  const emit: TraceEmit = (sessionID, type, payload) =>
    lines.push({ sessionID, type, payload });
  const plugin = createTraceLogger(emit);
  // 测试只用到 project.path 与 directory，其余按真实类型收窄。
  const hooks = await plugin({
    client: {},
    project: { path: "/proj" },
    directory: "/proj",
  } as never);
  return { lines, hooks };
}

/** 触发一条 bus event，模拟 opencode 的事件总线信封。 */
function bus(hooks: Hooks, event: unknown): Promise<void> | void {
  // 真实 Event 联合类型在测试里只用到子集，收窄到 unknown 信封。
  const fire = hooks.event as
    | ((input: { event: unknown }) => Promise<void>)
    | undefined;
  return fire?.({ event });
}

Deno.test("trace 目录尊重 XDG_DATA_HOME", () => {
  const original = Deno.env.get("XDG_DATA_HOME");
  try {
    Deno.env.set("XDG_DATA_HOME", "/tmp/xdg-data");
    check(traceDir() === "/tmp/xdg-data/opencode/trace", "XDG_DATA_HOME 优先");
    Deno.env.delete("XDG_DATA_HOME");
    const fallback = traceDir();
    check(
      fallback.endsWith("/.local/share/opencode/trace"),
      `回退到 ~/.local/share，got ${fallback}`,
    );
  } finally {
    if (original === undefined) {
      Deno.env.delete("XDG_DATA_HOME");
    } else {
      Deno.env.set("XDG_DATA_HOME", original);
    }
  }
});

Deno.test("session.created 产出 session.start 环境快照", async () => {
  const { lines, hooks } = await drive();
  await bus(hooks, {
    type: "session.created",
    properties: {
      session: {
        id: "ses_start",
        title: "标题",
        model: "model-x",
        providerID: "prov",
        agent: "build",
        parentID: "ses_parent",
      },
    },
  });

  const line = lines.find((line) => line.type === "session.start");
  check(line !== undefined, "存在 session.start 行");
  check(line!.sessionID === "ses_start", "sessionID 正确");
  check(line!.payload.title === "标题", "title 透传");
  check(line!.payload.model === "model-x", "model 透传");
  check(line!.payload.parentID === "ses_parent", "parentID 透传");
  check(line!.payload.project === "/proj", "project 取注入的 project.path");
});

Deno.test("message.updated 用户消息产出 message.user 且截断长文本", async () => {
  const { lines, hooks } = await drive();
  const longText = "长".repeat(4000);
  await bus(hooks, {
    type: "message.updated",
    properties: {
      message: {
        id: "m1",
        role: "user",
        sessionID: "ses_msg",
        parts: [{ type: "text", text: longText }],
      },
    },
  });

  const line = lines.find((line) => line.type === "message.user");
  check(line !== undefined, "存在 message.user 行");
  check(
    (line!.payload.text as string).endsWith("…[truncated]"),
    "超长用户输入被截断",
  );
  check(line!.payload.messageIndex === 1, "messageIndex 从 1 计数");
});

Deno.test("step-finish 累计 token 语义与移植前一致", async () => {
  const { lines, hooks } = await drive();
  await bus(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-start",
        sessionID: "ses_cum",
        messageID: "m2",
      },
    },
  });
  await bus(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: "ses_cum",
        messageID: "m2",
        tokens: { input: 100, output: 50, cache: { read: 10, write: 20 } },
      },
    },
  });
  // 第二个 step：input 取 max（上下文窗口滑动），cacheRead/Write 累加
  await bus(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-start",
        sessionID: "ses_cum",
        messageID: "m2",
      },
    },
  });
  await bus(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: "ses_cum",
        messageID: "m2",
        tokens: { input: 80, output: 5, cache: { read: 7, write: 3 } },
      },
    },
  });

  const steps = lines.filter((line) => line.type === "step.finish");
  check(steps.length === 2, "两条 step.finish");
  const cum1 = steps[0].payload.cumTokens as Record<string, number>;
  const cum2 = steps[1].payload.cumTokens as Record<string, number>;
  check(cum1.input === 100 && cum1.output === 50, "首次累计直取");
  check(cum1.cacheRead === 10 && cum1.cacheWrite === 20, "cache 首次直取");
  check(cum2.input === 100, "input 取 max 保持窗口峰值");
  check(cum2.output === 55, "output 累加");
  check(cum2.cacheRead === 17 && cum2.cacheWrite === 23, "cache 累加");
});

Deno.test("tool.execute before/after 产出 tool.start 与 tool.finish", async () => {
  const { lines, hooks } = await drive();
  const before = hooks["tool.execute.before"] as (
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => Promise<void>;
  const after = hooks["tool.execute.after"] as (
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ) => Promise<void>;

  await before(
    {
      sessionID: "ses_tool",
      tool: "bash",
      toolCallID: "tc1",
      messageID: "m2",
      args: { command: "ls" },
    },
    {},
  );
  await after(
    {
      sessionID: "ses_tool",
      tool: "bash",
      toolCallID: "tc1",
      messageID: "m2",
      args: { command: "ls" },
    },
    { output: "ok", stdout: "out", stderr: "err" },
  );

  const start = lines.find((line) => line.type === "tool.start");
  const finish = lines.find((line) => line.type === "tool.finish");
  check(start !== undefined, "存在 tool.start 行");
  check(
    start!.payload.tool === "bash" && start!.payload.toolCallId === "tc1",
    "start 身份正确",
  );
  check(finish !== undefined, "存在 tool.finish 行");
  check(finish!.payload.output === "ok", "output 文本透传");
  check(
    finish!.payload.stdout === "out" && finish!.payload.stderr === "err",
    "stdout/stderr 分离",
  );
  check(typeof finish!.payload.duration === "number", "duration 为毫秒数");
});

Deno.test("session.idle 产出 session.end 汇总，session.deleted 收尾", async () => {
  const { lines, hooks } = await drive();
  await bus(hooks, {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: "ses_idle",
        messageID: "m2",
        tokens: { input: 30, output: 10 },
      },
    },
  });
  await bus(hooks, {
    type: "session.idle",
    properties: { sessionID: "ses_idle" },
  });
  const end = lines.find((line) => line.type === "session.end");
  check(end !== undefined, "存在 session.end 行");
  check(
    (end!.payload.totalTokens as Record<string, number>).input === 30,
    "totalTokens 携带累计快照",
  );

  await bus(hooks, {
    type: "session.deleted",
    properties: { sessionID: "ses_idle" },
  });
  check(
    lines.some((line) => line.type === "session.deleted"),
    "存在 session.deleted 行",
  );
});

Deno.test("permission.updated/replied 记录授权阻塞时长", async () => {
  const { lines, hooks } = await drive();
  await bus(hooks, {
    type: "permission.updated",
    properties: {
      sessionID: "ses_perm",
      requestID: "r1",
      tool: "bash",
      permission: "run",
      patterns: ["ls"],
    },
  });
  const asked = lines.find((line) => line.type === "permission.asked");
  check(asked !== undefined, "存在 permission.asked 行");
  check(asked!.payload.patterns !== null, "patterns 透传");

  await bus(hooks, {
    type: "permission.replied",
    properties: { sessionID: "ses_perm", requestID: "r1", action: "allow" },
  });
  const replied = lines.find((line) => line.type === "permission.replied");
  check(replied !== undefined, "存在 permission.replied 行");
  check(replied!.payload.action === "allow", "action 透传");
  check(typeof replied!.payload.blockedMs === "number", "blockedMs 为毫秒数");
});
