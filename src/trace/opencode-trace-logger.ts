/**
 * opencode-trace-logger (完整版)
 *
 * 将每个 session 的完整事件流写入 NDJSON 文件
 *
 * 自 agent_trace_visualizer/plugins/trace_logger.ts 原样移植（除下述两处外逐字节一致）：
 *   - trace 目录尊重 XDG_DATA_HOME（原版硬编码 ~/.local/share）
 *   - emit 底层支持注入（createTraceLogger），默认实现仍为逐行落盘
 *
 * 新增内容（相较原版）：
 *   - experimental.session.compacting hook：捕获 compaction 开始时刻
 *   - session.compacted bus event：捕获 compaction 完成时刻，计算压缩耗时与压缩率
 *   - session.updated / session.deleted bus events
 *   - permission.updated / permission.replied bus events（Agent 被阻塞等待授权的全时序）
 *   - message.part.removed bus event
 *   - 全部缺失 Part 类型：reasoning / file / patch / agent / retry / subtask / snapshot
 *   - step-finish 补充 contextLimit、contextPressure
 *   - compaction Part 补充 tokensBefore、tokensFreed、compressionRatio、duration
 *   - tool.finish 补充 filePath 标准化字段、stdout/stderr 分离
 *   - session.start 补充环境快照
 *   - cacheRead/cacheWrite 改为累加（修复原版赋值 bug）
 *   - 步骤连续性：afterCompaction 标记
 */

import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── 路径 ─────────────────────────────────────────────────────────────────────

/** 数据目录根：尊重 XDG_DATA_HOME（原版硬编码 ~/.local/share）。 */
export function traceDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "trace");
}

const TRACE_DIR = traceDir();

try {
  mkdirSync(TRACE_DIR, { recursive: true });
} catch {
  // 目录已存在或不可写：继续运行，逐行写入时再各自容错。
}

// ─── 状态类型 ─────────────────────────────────────────────────────────────────

interface PendingTool {
  tool: string;
  args: Record<string, unknown>;
  startTs: number;
  stepIndex: number;
  globalStep: number;
}

interface CumTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface PendingPermission {
  requestID: string;
  tool: string;
  permission: string;
  patterns: unknown;
  askedTs: number;
}

interface SessionState {
  sessionID: string;
  logPath: string;
  stepIndex: number;
  globalStep: number;
  msgIndex: number;
  lastMsgID: string;
  pendingTools: Map<string, PendingTool>;
  cumTokens: CumTokens;

  // ── 上下文压缩时序 ──────────────────────────────────────
  compactionStartTs: number | null; // experimental.session.compacting 触发时刻
  tokensBeforeCompaction: CumTokens | null; // 压缩前的 token 快照
  lastCompactionGlobalStep: number | null; // 用于标记下一个 step 是 afterCompaction

  // ── 权限等待时序 ────────────────────────────────────────
  pendingPermissions: Map<string, PendingPermission>;
}

const sessions = new Map<string, SessionState>();

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function getOrCreate(sessionID: string): SessionState {
  if (!sessions.has(sessionID)) {
    const logPath = join(TRACE_DIR, `${sessionID}.ndjson`);
    sessions.set(sessionID, {
      sessionID,
      logPath,
      stepIndex: 0,
      globalStep: 0,
      msgIndex: 0,
      lastMsgID: "",
      pendingTools: new Map(),
      cumTokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      },
      compactionStartTs: null,
      tokensBeforeCompaction: null,
      lastCompactionGlobalStep: null,
      pendingPermissions: new Map(),
    });
  }
  return sessions.get(sessionID)!;
}

/** 注入式事件出口：工厂版绕过文件系统（测试与未来接线的入口）。 */
export type TraceEmit = (
  sessionID: string,
  type: string,
  payload: Record<string, unknown>,
) => void;

function extractOutput(output: unknown): string {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return (output as { text?: string; content?: string }[])
      .map((x) => x.text ?? x.content ?? "")
      .join("\n");
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (obj.text) return String(obj.text);
    if (obj.content) return String(obj.content);
    return JSON.stringify(output);
  }
  return String(output);
}

function getToolCallId(inp: Record<string, unknown>): string {
  return String(
    inp.toolCallID ??
      inp.tool_call_id ??
      `${
        inp.messageID ?? inp.message_id ?? "global"
      }-${inp.tool}-${Date.now()}`,
  );
}

function sanitizeArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args) return {};
  if (tool === "edit" || tool === "write") {
    const trim = (v: unknown, max = 600) =>
      typeof v === "string" && v.length > max
        ? v.slice(0, max) + "…[truncated]"
        : v;
    return {
      ...args,
      newText: trim(args.newText),
      oldText: trim(args.oldText),
      content: trim(args.content),
    };
  }
  return args;
}

function normTokens(t: Record<string, unknown> = {}): CumTokens {
  const cache = t.cache as Record<string, number> | undefined;
  return {
    input: Number(t.input ?? 0),
    output: Number(t.output ?? 0),
    reasoning: Number(t.reasoning ?? 0),
    cacheRead: Number(cache?.read ?? t.cache_read ?? 0),
    cacheWrite: Number(cache?.write ?? t.cache_write ?? 0),
  };
}

/**
 * 从工具参数中提取文件路径（用于文件访问图谱可视化）
 */
function extractFilePath(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  const FILE_TOOLS = [
    "read",
    "edit",
    "write",
    "glob",
    "grep",
    "patch",
    "apply_patch",
    "multiedit",
    "todo_read",
    "todo_write",
  ];
  if (FILE_TOOLS.includes(tool)) {
    const raw = args.filePath ?? args.path ?? args.file ?? args.target ?? "";
    return String(raw) || null;
  }
  return null;
}

function extractSID(props: Record<string, unknown>): string {
  return String(
    (props.session as Record<string, unknown>)?.id ?? props.sessionID ??
      props.session_id ?? "",
  );
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function createTraceLogger(emit: TraceEmit): Plugin {
  // deno-lint-ignore require-await
  return async ({ client: _client, project, directory }) => {
    /** 把 state 绑定的事件出口收敛到注入的 emit；payload 序列化交给接收方。 */
    const emitEvent = (
      state: SessionState,
      type: string,
      payload: Record<string, unknown>,
    ) => emit(state.sessionID, type, payload);
    return {
      // ══════════════════════════════════════════════════════════════════════════
      // Bus events
      // ══════════════════════════════════════════════════════════════════════════
      // deno-lint-ignore require-await
      event: async ({ event }) => {
        const ev = event as Record<string, unknown>;
        const props = (ev.properties ?? {}) as Record<string, unknown>;

        switch (ev.type) {
          // ── Session 生命周期 ──────────────────────────────────────────────────

          case "session.created": {
            const sess = (props.session ?? props) as Record<string, unknown>;
            const sid = String(sess.id ?? props.sessionID ?? "");
            if (!sid) break;
            const state = getOrCreate(sid);
            emitEvent(state, "session.start", {
              title: String(sess.title ?? ""),
              model: String(sess.model ?? ""),
              providerID: String(
                sess.providerID ??
                  (sess.model as Record<string, unknown>)?.providerID ?? "",
              ),
              agent: String(sess.agent ?? ""),
              parentID: String(sess.parentID ?? "") || null,
              project: String(
                (project as { path?: string } | undefined)?.path ?? directory ??
                  process.cwd(),
              ),
              // 环境快照
              cwd: String(process.cwd()),
              platform: process.platform,
              nodeVersion: process.version,
            });
            break;
          }

          case "session.updated": {
            // 模型切换、title 变更等，多模型会话分析必需
            const sess = (props.session ?? props) as Record<string, unknown>;
            const sid = extractSID(props);
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;
            emitEvent(state, "session.updated", {
              model: String(sess.model ?? ""),
              title: String(sess.title ?? ""),
              agent: String(sess.agent ?? ""),
            });
            break;
          }

          case "session.idle": {
            const sid = extractSID(props);
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;
            emitEvent(state, "session.end", { totalTokens: state.cumTokens });
            break;
          }

          case "session.deleted": {
            const sid = extractSID(props);
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;
            emitEvent(state, "session.deleted", {});
            sessions.delete(sid);
            break;
          }

          case "session.error": {
            const sid = extractSID(props);
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;
            emitEvent(state, "session.error", {
              error: props.error ?? ev.error ?? {},
            });
            break;
          }

          /**
           * session.compacted — compaction LLM 调用完成后触发
           * 与 experimental.session.compacting hook 配合，可以精确计算压缩耗时。
           */
          case "session.compacted": {
            const sid = String(props.sessionID ?? "");
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;

            const duration = state.compactionStartTs != null
              ? Date.now() - state.compactionStartTs
              : null;
            const tokensBefore = state.tokensBeforeCompaction;

            emitEvent(state, "compaction.complete", {
              duration, // compaction LLM 调用总耗时（ms）
              tokensBefore, // 压缩前 token 快照
              // tokensAfter 在 compaction Part 事件中记录，因为那里才有 summary token 数据
              globalStep: state.globalStep,
            });

            // 标记下一个 step 是 afterCompaction
            state.lastCompactionGlobalStep = state.globalStep;
            state.compactionStartTs = null;
            state.tokensBeforeCompaction = null;
            break;
          }

          // ── Message ──────────────────────────────────────────────────────────

          case "message.updated": {
            const msg = props.message as Record<string, unknown> | undefined;
            if (!msg || msg.role !== "user") break;
            const sid = String(msg.sessionID ?? "");
            if (!sid) break;
            const state = getOrCreate(sid);
            state.msgIndex++;
            state.stepIndex = 0;
            const parts = (msg.parts as {
              type?: string;
              text?: string;
              synthetic?: boolean;
            }[]) ?? [];
            const text = parts.filter((p) => p.type === "text" && !p.synthetic)
              .map((p) => p.text ?? "").join("\n");
            if (!text.trim()) break;
            emitEvent(state, "message.user", {
              messageID: String(msg.id ?? ""),
              messageIndex: state.msgIndex,
              text: text.length > 3000
                ? text.slice(0, 3000) + "…[truncated]"
                : text,
            });
            break;
          }

          case "message.part.removed": {
            // 工具输出被 prune 时触发，标记哪些历史数据被剔除出上下文
            const sid = String(props.sessionID ?? "");
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;
            emitEvent(state, "message.part.removed", {
              messageID: String(props.messageID ?? ""),
              partID: String(props.partID ?? ""),
            });
            break;
          }

          // ── 权限系统 ─────────────────────────────────────────────────────────

          /**
           * permission.updated — Agent 发起权限请求，等待用户回应
           * 与 permission.replied 配合，可计算 Agent 被阻塞等待的时长。
           */
          case "permission.updated": {
            const sid = String(props.sessionID ?? "");
            if (!sid) break;
            const state = getOrCreate(sid);
            const requestID = String(props.requestID ?? "");
            if (!requestID) break;

            const perm: PendingPermission = {
              requestID,
              tool: String(props.tool ?? ""),
              permission: String(props.permission ?? ""),
              patterns: props.patterns ?? props.pattern ?? null,
              askedTs: Date.now(),
            };
            state.pendingPermissions.set(requestID, perm);

            emitEvent(state, "permission.asked", {
              requestID,
              tool: perm.tool,
              permission: perm.permission,
              patterns: perm.patterns,
              globalStep: state.globalStep,
            });
            break;
          }

          /**
           * permission.replied — 用户对权限请求作出回应（allow / deny / always）
           * blockedMs = 从 permission.asked 到此事件的时长，代表 Agent 被阻塞等待的时间。
           */
          case "permission.replied": {
            const sid = String(props.sessionID ?? "");
            if (!sid) break;
            const state = sessions.get(sid);
            if (!state) break;
            const requestID = String(props.requestID ?? "");
            const pending = state.pendingPermissions.get(requestID);
            const blockedMs = pending ? Date.now() - pending.askedTs : null;

            if (pending) state.pendingPermissions.delete(requestID);

            emitEvent(state, "permission.replied", {
              requestID,
              action: String(props.action ?? props.decision ?? ""),
              tool: pending?.tool ?? String(props.tool ?? ""),
              permission: pending?.permission ?? String(props.permission ?? ""),
              blockedMs, // Agent 等待用户授权的时长（ms），核心时序指标
              globalStep: state.globalStep,
            });
            break;
          }

          // ── message.part.updated（流式 Part 处理）────────────────────────────

          case "message.part.updated": {
            const part = props.part as Record<string, unknown> | undefined;
            if (!part) break;
            const sid = String(part.sessionID ?? props.sessionID ?? "");
            if (!sid) break;
            const state = getOrCreate(sid);
            const mid = String(part.messageID ?? "");

            switch (part.type) {
              case "step-start": {
                if (mid && mid !== state.lastMsgID) {
                  state.stepIndex = 0;
                  state.lastMsgID = mid;
                }
                state.stepIndex++;
                state.globalStep++;

                const afterCompaction =
                  state.lastCompactionGlobalStep != null &&
                  state.globalStep === state.lastCompactionGlobalStep + 1;

                emitEvent(state, "step.start", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  afterCompaction, // 上下文断层标记：该 step 在 compaction 后立即执行
                  snapshot: part.snapshot ?? null,
                });
                break;
              }

              case "step-finish": {
                const tok = normTokens(
                  part.tokens as Record<string, unknown> ?? {},
                );

                // input token 用 max（反映上下文窗口滑动）
                state.cumTokens.input = Math.max(
                  state.cumTokens.input,
                  tok.input,
                );
                state.cumTokens.output += tok.output;
                // ★ 修复原版 bug：cacheRead/Write 应累加，否则 cumTokens 的语义与命名不符
                state.cumTokens.cacheRead += tok.cacheRead;
                state.cumTokens.cacheWrite += tok.cacheWrite;
                state.cumTokens.reasoning += tok.reasoning;

                // 上下文压力分析：接近上限时自动记录压缩前快照
                const contextLimit =
                  Number(part.contextLimit ?? part.maxTokens ?? 0) || null;
                const contextPressure = contextLimit
                  ? state.cumTokens.input / contextLimit
                  : null;

                if (
                  contextPressure != null && contextPressure > 0.7 &&
                  state.tokensBeforeCompaction == null
                ) {
                  // 提前记录快照，供后续 compaction 计算使用
                  state.tokensBeforeCompaction = { ...state.cumTokens };
                }

                emitEvent(state, "step.finish", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  tokens: tok,
                  cumTokens: { ...state.cumTokens },
                  cost: Number(part.cost ?? 0),
                  reason: String(part.reason ?? ""),
                  contextLimit,
                  contextPressure, // 0~1，可视化上下文压力进度条
                });
                break;
              }

              case "text": {
                if (part.synthetic) break;
                const text = String(part.text ?? "");
                if (!text.trim()) break;
                emitEvent(state, "text.assistant", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  text: text.length > 3000
                    ? text.slice(0, 3000) + "…[truncated]"
                    : text,
                });
                break;
              }

              /**
               * reasoning — 模型思考链（extended thinking 专用）
               * 是决策分析最有价值的数据，但不应全量存储（可能很长）。
               */
              case "reasoning": {
                const thinking = String(part.thinking ?? part.text ?? "");
                if (!thinking.trim()) break;
                emitEvent(state, "reasoning", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  thinkingLength: thinking.length,
                  // 只存前 5000 字符，完整内容留给需要深度分析时再从原始消息拉取
                  thinking: thinking.length > 5000
                    ? thinking.slice(0, 5000) + "…[truncated]"
                    : thinking,
                });
                break;
              }

              /**
               * compaction — 压缩 Part 写入消息流
               * 此处记录压缩后 token 数，与 compaction.complete 事件配合得到完整时序。
               */
              case "compaction": {
                const tok = normTokens(
                  part.tokens as Record<string, unknown> ?? {},
                );
                const tokensBefore = state.tokensBeforeCompaction ??
                  { ...state.cumTokens };
                const tokensFreed = tokensBefore.input - tok.input;
                const compressionRatio = tokensBefore.input > 0
                  ? tokensFreed / tokensBefore.input
                  : 0;
                const duration = state.compactionStartTs
                  ? Date.now() - state.compactionStartTs
                  : null;

                emitEvent(state, "compaction", {
                  messageID: mid,
                  globalStep: state.globalStep,
                  summary: String(part.summary ?? "").slice(0, 300),
                  tokens: tok, // 压缩后
                  tokensBefore, // 压缩前
                  tokensFreed, // 释放了多少 input token
                  compressionRatio, // 压缩率（0~1），前端饼图/进度条用
                  duration, // compaction LLM 调用耗时（ms）
                  auto: Boolean(part.auto ?? true),
                });

                // 更新 cumTokens（input 重置为压缩后的值）
                state.cumTokens.input = tok.input;
                break;
              }

              /**
               * file — Agent 读取/写入了某个文件（文件访问图谱的原始数据）
               */
              case "file": {
                emitEvent(state, "file.access", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  filePath: String(part.filePath ?? part.path ?? ""),
                  operation: String(part.operation ?? part.action ?? "read"),
                });
                break;
              }

              /**
               * patch — diff/patch 操作的结构化结果
               */
              case "patch": {
                const raw = String(part.patch ?? part.diff ?? "");
                emitEvent(state, "patch", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  filePath: String(part.filePath ?? part.path ?? ""),
                  patchSize: raw.length,
                  patch: raw.length > 4000
                    ? raw.slice(0, 4000) + "…[truncated]"
                    : raw,
                });
                break;
              }

              /**
               * agent / subtask — 子 Agent 派发（task 工具创建子 session）
               * 记录子 session ID 可在可视化时绘制树状 Agent 结构。
               */
              case "agent":
              case "subtask": {
                emitEvent(state, "subagent.spawn", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  childSessionID: String(
                    part.sessionID ?? part.childSessionID ?? "",
                  ),
                  agentName: String(part.agent ?? part.name ?? ""),
                  partType: String(part.type),
                });
                break;
              }

              /**
               * retry — LLM 调用重试（用于分析不稳定性和错误率）
               */
              case "retry": {
                emitEvent(state, "llm.retry", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  attempt: Number(part.attempt ?? 1),
                  error: String(part.error ?? part.message ?? ""),
                  delay: Number(part.delay ?? 0),
                });
                break;
              }

              /**
               * snapshot — 工作区快照（revert 功能的基础）
               */
              case "snapshot": {
                emitEvent(state, "snapshot", {
                  messageID: mid,
                  stepIndex: state.stepIndex,
                  globalStep: state.globalStep,
                  snapshotID: String(part.snapshotID ?? part.id ?? ""),
                });
                break;
              }
            }
            break;
          }
        }
      },

      // ══════════════════════════════════════════════════════════════════════════
      // experimental.session.compacting hook
      // 在 compaction LLM 调用发起前触发，是记录 compaction 开始时刻的唯一入口。
      // ══════════════════════════════════════════════════════════════════════════
      // deno-lint-ignore require-await
      "experimental.session.compacting": async (input, output) => {
        const inp = input as Record<string, unknown>;
        const sid = String(inp.sessionID ?? inp.session_id ?? "");
        if (!sid) return;

        const state = getOrCreate(sid);
        // 记录压缩开始时刻
        state.compactionStartTs = Date.now();
        // 如果还没有通过 contextPressure 预记录快照，则在此补记
        if (!state.tokensBeforeCompaction) {
          state.tokensBeforeCompaction = { ...state.cumTokens };
        }

        emitEvent(state, "compaction.start", {
          globalStep: state.globalStep,
          tokensBefore: { ...state.cumTokens },
          auto: Boolean(inp.auto ?? true),
          // 如果 output.context 被注入了自定义内容，记录注入了多少
          contextInjected: output?.context?.length ?? 0,
        });

        // 不修改 output，仅观测
      },

      // ══════════════════════════════════════════════════════════════════════════
      // tool hooks
      // ══════════════════════════════════════════════════════════════════════════
      // deno-lint-ignore require-await
      "tool.execute.before": async (input, output) => {
        const inp = input as Record<string, unknown>;
        const out = output as Record<string, unknown>;
        const sid = String(inp.sessionID ?? inp.session_id ?? "");
        if (!sid) return;

        const state = getOrCreate(sid);
        const args = sanitizeArgs(
          String(inp.tool),
          (out.args ?? inp.args ?? {}) as Record<string, unknown>,
        );
        const callId = getToolCallId(inp);

        state.pendingTools.set(callId, {
          tool: String(inp.tool),
          args,
          startTs: Date.now(),
          stepIndex: state.stepIndex,
          globalStep: state.globalStep,
        });

        emitEvent(state, "tool.start", {
          messageID: String(inp.messageID ?? inp.message_id ?? ""),
          toolCallId: callId,
          tool: String(inp.tool),
          stepIndex: state.stepIndex,
          globalStep: state.globalStep,
          args,
          filePath: extractFilePath(String(inp.tool), args),
        });
      },

      // deno-lint-ignore require-await
      "tool.execute.after": async (input, output) => {
        const inp = input as Record<string, unknown>;
        const out = output as Record<string, unknown>;
        const sid = String(inp.sessionID ?? inp.session_id ?? "");
        if (!sid) return;

        const state = getOrCreate(sid);
        const callId = getToolCallId(inp);
        const pending = state.pendingTools.get(callId);

        if (pending) state.pendingTools.delete(callId);

        const duration = pending ? Date.now() - pending.startTs : null;
        const meta = (inp.metadata ?? {}) as Record<string, unknown>;
        const rawOutput = out?.output ?? out?.result ?? out?.content ??
          inp.output ?? inp.result ?? inp.content;
        const outText = extractOutput(rawOutput);
        const isError = Boolean(inp.error ?? out?.error);
        const exitCode =
          Number(meta.exitCode ?? inp.exitCode ?? (isError ? 1 : 0)) || null;
        const args = sanitizeArgs(
          String(inp.tool),
          (inp.args ?? {}) as Record<string, unknown>,
        );

        // bash 工具：分离 stdout / stderr（供错误分析使用）
        const stdout = out?.stdout != null
          ? String(out.stdout).slice(0, 8000)
          : null;
        const stderr = out?.stderr != null
          ? String(out.stderr).slice(0, 2000)
          : null;

        emitEvent(state, "tool.finish", {
          messageID: String(inp.messageID ?? inp.message_id ?? ""),
          toolCallId: callId,
          tool: String(inp.tool),
          stepIndex: pending?.stepIndex ?? state.stepIndex,
          globalStep: pending?.globalStep ?? state.globalStep,
          args,
          filePath: extractFilePath(String(inp.tool), args),
          output: outText.length > 16000
            ? outText.slice(0, 16000) + "\n…[truncated]"
            : outText,
          outputSize: outText.length,
          stdout,
          stderr,
          isError,
          exitCode,
          duration,
        });
      },
    };
  };
}

/** 默认落盘实现：与移植前行为逐字节一致（每事件一行 JSON，追加写）。 */
export default createTraceLogger((sessionID, type, payload) => {
  const state = sessions.get(sessionID);
  if (!state) return;
  const line = JSON.stringify({ type, ts: Date.now(), sessionID, ...payload }) +
    "\n";
  try {
    appendFileSync(state.logPath, line, "utf8");
  } catch {
    // 写入失败（目录消失/磁盘满）：丢弃本行，不影响会话继续。
  }
});
