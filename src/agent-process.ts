import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { EvidenceEvent, ExecutionResult, Scenario } from "./types.js";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_EVIDENCE_EVENTS = 10_000;

interface AgentProcessOptions {
  scenario: Scenario;
  fixtures: Record<string, unknown>;
  command: string[];
  cwd: string;
}

export class AgentExecutionError extends Error {
  constructor(
    message: string,
    readonly execution: ExecutionResult
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

type AgentOutput =
  | {
      type: "tool_call";
      callId: string;
      tool: string;
      arguments?: Record<string, unknown>;
    }
  | {
      type: "confirmation";
      confirmed: boolean;
      tool: string;
      source?: string;
    }
  | {
      type: "final";
      status: string;
      output?: unknown;
    };

type EvidenceInput =
  | AgentOutput
  | {
      type: "tool_result";
      callId: string;
      tool: string;
      result: unknown;
    };

function parseAgentOutput(line: string): AgentOutput {
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Agent emitted invalid JSONL: ${line}`);
  }

  if (typeof event !== "object" || event === null || !("type" in event)) {
    throw new Error(`Agent emitted an invalid event: ${line}`);
  }

  const candidate = event as Record<string, unknown>;
  if (
    candidate.type === "tool_call" &&
    typeof candidate.callId === "string" &&
    candidate.callId.length > 0 &&
    typeof candidate.tool === "string" &&
    candidate.tool.length > 0 &&
    (candidate.arguments === undefined ||
      (typeof candidate.arguments === "object" &&
        candidate.arguments !== null &&
        !Array.isArray(candidate.arguments)))
  ) {
    return candidate as AgentOutput;
  }
  if (
    candidate.type === "confirmation" &&
    typeof candidate.confirmed === "boolean" &&
    typeof candidate.tool === "string" &&
    candidate.tool.length > 0 &&
    (candidate.source === undefined || typeof candidate.source === "string")
  ) {
    return candidate as AgentOutput;
  }
  if (
    candidate.type === "final" &&
    typeof candidate.status === "string" &&
    candidate.status.length > 0
  ) {
    return candidate as AgentOutput;
  }

  throw new Error(`Agent emitted an unsupported event: ${line}`);
}

export async function executeAgentProcess(
  options: AgentProcessOptions
): Promise<ExecutionResult> {
  if (options.command.length === 0) {
    throw new Error("No agent command was provided");
  }

  const startedAt = new Date();
  const evidence: EvidenceEvent[] = [];
  const hardTimeoutMs = Math.max(
    (options.scenario.performance?.maxDurationMs ?? 15_000) * 2,
    5_000
  );

  return new Promise<ExecutionResult>((resolvePromise, rejectPromise) => {
    const child = spawn(options.command[0], options.command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, AGENTDOCTOR_PROTOCOL: "0.1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let stdoutBytes = 0;
    let finalReceived = false;
    let settled = false;
    const callIds = new Set<string>();

    const snapshot = (): ExecutionResult => ({
      command: options.command,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      evidence: [...evidence],
      stderr
    });

    const record = (event: EvidenceInput) => {
      if (evidence.length >= MAX_EVIDENCE_EVENTS) {
        throw new Error(`Agent exceeded the evidence limit of ${MAX_EVIDENCE_EVENTS} events`);
      }
      evidence.push({
        ...event,
        sequence: evidence.length + 1,
        timestamp: new Date().toISOString()
      } as EvidenceEvent);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      rejectPromise(new AgentExecutionError(error.message, snapshot()));
    };

    const timeout = setTimeout(() => {
      fail(new Error(`Agent exceeded the hard timeout of ${hardTimeoutMs}ms`));
    }, hardTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new Error(`Agent stdout exceeded the ${MAX_STDOUT_BYTES}-byte limit`));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
        fail(new Error(`Agent stderr exceeded the ${MAX_STDERR_BYTES}-byte limit`));
      }
    });

    child.stdin.on("error", (error) => {
      fail(new Error(`Could not send input to agent: ${error.message}`));
    });

    child.on("error", (error) => {
      fail(new Error(`Could not start agent command: ${error.message}`));
    });

    child.on("spawn", () => {
      child.stdin.write(
        `${JSON.stringify({
          type: "run_start",
          scenarioId: options.scenario.id,
          input: options.scenario.input
        })}\n`
      );
    });

    lines.on("line", (line) => {
      if (line.trim().length === 0 || settled) return;

      try {
        if (finalReceived) {
          throw new Error("Agent emitted output after its final event");
        }
        const event = parseAgentOutput(line);
        if (event.type === "tool_call") {
          if (callIds.has(event.callId)) {
            throw new Error(`Agent reused tool call ID: ${event.callId}`);
          }
          callIds.add(event.callId);
          const toolEvent = {
            ...event,
            arguments: event.arguments ?? {}
          };
          record(toolEvent);

          if (!Object.hasOwn(options.fixtures, event.tool)) {
            fail(new Error(`No fixture is configured for tool ${event.tool}`));
            return;
          }

          const result = options.fixtures[event.tool];
          record({
            type: "tool_result",
            callId: event.callId,
            tool: event.tool,
            result
          });
          child.stdin.write(
            `${JSON.stringify({
              type: "tool_result",
              callId: event.callId,
              tool: event.tool,
              result
            })}\n`
          );
          return;
        }

        record(event);
        if (event.type === "final") {
          finalReceived = true;
          child.stdin.end();
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.on("close", (code) => {
      if (settled) return;

      if (code !== 0) {
        fail(
          new Error(`Agent exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`)
        );
        return;
      }
      if (!finalReceived) {
        fail(new Error("Agent exited without emitting a final event"));
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolvePromise(snapshot());
    });
  });
}