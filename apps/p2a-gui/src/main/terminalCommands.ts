import { AGENT_TOOLS, type AgentTool } from "../shared/ipc";

export type ResolvedAgentCommand = {
  command: string;
  args: string[];
};

const AGENT_COMMANDS: Record<AgentTool, ResolvedAgentCommand> = {
  codex: { command: "codex", args: [] },
  claude: { command: "claude", args: [] },
  gemini: { command: "gemini", args: [] },
  aider: { command: "aider", args: [] },
  cursor: { command: "cursor", args: [] },
};

export function isAgentTool(value: unknown): value is AgentTool {
  return typeof value === "string" && AGENT_TOOLS.includes(value as AgentTool);
}

export function resolveAgentCommand(agentTool: AgentTool): ResolvedAgentCommand {
  return AGENT_COMMANDS[agentTool];
}

export function normalizePtyDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(8, Math.min(300, Math.round(value)));
}

export function resolveTerminalStopSignal(
  intent: "stop" | "kill",
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  return intent === "kill" ? "SIGKILL" : "SIGTERM";
}
