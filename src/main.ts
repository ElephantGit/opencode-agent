import type {
  AcpSender,
  AgentModel,
  AgentStartContext,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  AgentPlugin,
  type PluginContext,
  runAgentPlugin,
} from "./base/agent-plugin.ts";
import { forwardAcpFrame } from "./handlers/acp.ts";
import { SkillEffectCoordinator } from "./handlers/effects.ts";
import { startOpenCode, stopOpenCode } from "./handlers/lifecycle.ts";
import { listOpenCodeModels } from "./handlers/models.ts";
import { deployTraceLogger, pruneOldTraces } from "./handlers/trace.ts";
import { OpenCodeClient } from "./services/opencode-client.ts";

/** Must match `ora.id` in package.json, which is also this agent's identity inside Ora. */
const PLUGIN_ID = "ora-space.opencode";

/**
 * Publishes OpenCode as an Ora agent.
 *
 * One plugin process is one agent, so this class owns exactly one CLI and needs no addressing of
 * its own. Every API is delegated to a handler module, which keeps the entrypoint to wiring: the
 * sender handed in by `agent/start`, the CLI bridge, and the route mounting below.
 */
class OpenCodeAgentPlugin extends AgentPlugin {
  /** Valid only between `agent/start` and the end of the process; frames before that are lost. */
  #send: AcpSender | undefined;
  /** The workspace root the CLI is running against; also what a Skill Effect restart respawns into. */
  #cwd: string | undefined;

  readonly #client = new OpenCodeClient({
    onAcpFrame: (frame) => {
      this.#effects.observe(frame);
      // A send failure means the host connection is already gone; there is nothing this plugin
      // can do with the frame, and throwing here would only kill the stdout pump.
      void this.#send?.(frame).catch((error) => {
        console.warn(`failed to forward ACP frame to the host: ${error}`);
      });
    },
    onExited: () => {
      console.warn(
        "the OpenCode CLI exited on its own; Ora decides whether to reconnect",
      );
    },
  });

  readonly #effects = new SkillEffectCoordinator(this.#client, () => this.#cwd);

  override readonly effects = this.#effects.definition;

  override async onActivate(context: PluginContext): Promise<void> {
    console.info(`${context.pluginId} activated`);
    // 采集器必须在 agent/start 拉起 opencode 之前就位：opencode 只在进程启动时
    // 扫描插件目录。部署幂等（版本戳+hash），升级后重启会静默覆盖旧版本。
    try {
      const deployed = await deployTraceLogger();
      const pruned = pruneOldTraces();
      console.info(
        `trace logger deployed at ${deployed.path} (changed=${deployed.changed}); pruned ${pruned} old traces`,
      );
    } catch (error) {
      // 部署失败不阻断 agent 本体：dashboard 侧只会读不到 trace。
      console.warn(`trace logger deployment failed: ${error}`);
    }
  }

  override onStart = async (
    context: AgentStartContext,
    send: AcpSender,
  ): Promise<void> => {
    this.#send = send;
    this.#cwd = context.cwd;
    await startOpenCode(this.#client, context);
  };

  override onStop = (): Promise<void> => stopOpenCode(this.#client);

  override onListModels = (): Promise<AgentModel[]> => listOpenCodeModels();

  override onAcp = (frame: JsonValue): Promise<void> | void =>
    forwardAcpFrame(this.#client, this.#effects, frame);

  override async onDeactivate(): Promise<void> {
    await this.#client.stop();
  }
}

await runAgentPlugin(new OpenCodeAgentPlugin(), { pluginId: PLUGIN_ID });
