import { describe, expect, it } from "vitest";
import {
  normalizePtyDimension,
  resolveAgentCommand,
  resolveTerminalStopSignal,
} from "./terminalCommands";

describe("terminal command helpers", () => {
  it("resolves supported agent tools to CLI commands", () => {
    expect(resolveAgentCommand("codex")).toEqual({ command: "codex", args: [] });
    expect(resolveAgentCommand("claude")).toEqual({ command: "claude", args: [] });
    expect(resolveAgentCommand("gemini")).toEqual({ command: "gemini", args: [] });
    expect(resolveAgentCommand("aider")).toEqual({ command: "aider", args: [] });
    expect(resolveAgentCommand("cursor")).toEqual({ command: "cursor", args: [] });
  });

  it("normalizes PTY dimensions into a bounded integer range", () => {
    expect(normalizePtyDimension(120.8, 80)).toBe(121);
    expect(normalizePtyDimension(2, 80)).toBe(8);
    expect(normalizePtyDimension(420, 80)).toBe(300);
    expect(normalizePtyDimension("bad", 80)).toBe(80);
  });

  it("chooses platform-safe stop and kill signals", () => {
    expect(resolveTerminalStopSignal("stop", "darwin")).toBe("SIGTERM");
    expect(resolveTerminalStopSignal("kill", "darwin")).toBe("SIGKILL");
    expect(resolveTerminalStopSignal("stop", "linux")).toBe("SIGTERM");
    expect(resolveTerminalStopSignal("kill", "win32")).toBeUndefined();
  });
});
