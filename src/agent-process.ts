import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createRedactor } from "./redaction.js";
import type {
  ToolBackend,
  ToolBackendStartupEvent
} from "./tool-backend.js";
import type {
  EvidenceEvent,
  EvidenceEventInput,
  ExecutionResult,
  ResolvedFixtures,
  Scenario
} from "./types.js";
import { isStructurallyEqual, isSubset } from "./value-match.js";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_EVIDENCE_EVENTS = 10_000;
const TERMINATION_GRACE_MS = 250;
const FORCE_KILL_WAIT_MS = 1000;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The process exited between status inspection and signaling.
      }
    }
  }
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await delay(20);
  }
}

export async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    const processGroupId = child.pid;
    signalProcessTree(child, "SIGTERM");
    await delay(TERMINATION_GRACE_MS);
    signalProcessTree(child, "SIGKILL");
    await Promise.all([
      waitForExit(child, FORCE_KILL_WAIT_MS),
      waitForProcessGroupGone(processGroupId, FORCE_KILL_WAIT_MS)
    ]);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
  signalProcessTree(child, "SIGKILL");
  await waitForExit(child, FORCE_KILL_WAIT_MS);
}

interface AgentProcessOptions {
  scenario: Scenario;
  fixtures: ResolvedFixtures;
  command: string[];
  cwd: string;
  toolBackend?: ToolBackend;
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

export class AgentAuthorizationDeniedError extends AgentExecutionError {
  constructor(message: string, execution: ExecutionResult) {
    super(message, execution);
    this.name = "AgentAuthorizationDeniedError";
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
      arguments?: Record<string, unknown>;
    }
  | {
      type: "final";
      status: string;
      output?: unknown;
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
    &&
    (candidate.arguments === undefined ||
      (typeof candidate.arguments === "object" &&
        candidate.arguments !== null &&
        !Array.isArray(candidate.arguments)))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBackendStartupEvents(value: unknown): ToolBackendStartupEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("Tool backend start must return an array of discovery events");
  }

  return value.map((event) => {
    if (
      !isRecord(event) ||
      event.type !== "mcp_discovery" ||
      !Array.isArray(event.serverCommand) ||
      !event.serverCommand.every((part) => typeof part === "string") ||
      !isRecord(event.capabilities) ||
      !Array.isArray(event.tools) ||
      !event.tools.every(
        (tool) => isRecord(tool) && typeof tool.name === "string"
      ) ||
      typeof event.durationMs !== "number" ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0 ||
      (event.serverInfo !== undefined &&
        (!isRecord(event.serverInfo) ||
          typeof event.serverInfo.name !== "string" ||
          typeof event.serverInfo.version !== "string")) ||
      (event.capabilitySnapshotMatches !== undefined &&
        typeof event.capabilitySnapshotMatches !== "boolean") ||
      (event.toolSnapshotMatches !== undefined &&
        typeof event.toolSnapshotMatches !== "boolean") ||
      (event.driftedTools !== undefined &&
        (!Array.isArray(event.driftedTools) ||
          !event.driftedTools.every((tool) => typeof tool === "string")))
    ) {
      throw new Error(
        "Tool backend start returned an invalid event; only MCP discovery evidence is accepted"
      );
    }
    return event as ToolBackendStartupEvent;
  });
}

export async function executeAgentProcess(
  options: AgentProcessOptions
): Promise<ExecutionResult> {
  if (options.command.length === 0) {
    throw new Error("No agent command was provided");
  }

  const startedAt = new Date();
  const evidence: EvidenceEvent[] = [];
  let stderr = "";
  const hardTimeoutMs = Math.max(
    (options.scenario.performance?.maxDurationMs ?? 15_000) * 2,
    5_000
  );
  const redact = createRedactor(options.toolBackend?.redaction);
  const sanitize = <T>(value: T): T => redact(value) as T;

  const snapshot = (): ExecutionResult => ({
    command: options.command,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    evidence: [...evidence],
    stderr: sanitize(stderr)
  });

  const record = (event: EvidenceEventInput) => {
    if (evidence.length >= MAX_EVIDENCE_EVENTS) {
      throw new Error(`Agent exceeded the evidence limit of ${MAX_EVIDENCE_EVENTS} events`);
    }
    evidence.push({
      ...event,
      sequence: evidence.length + 1,
      timestamp: new Date().toISOString()
    } as EvidenceEvent);
  };

  if (options.toolBackend) {
    try {
      const startupEvents = requireBackendStartupEvents(
        await options.toolBackend.start(hardTimeoutMs)
      );
      for (const event of startupEvents) record(event);
    } catch (error) {
      throw new AgentExecutionError(
        sanitize(error instanceof Error ? error.message : String(error)),
        snapshot()
      );
    }
  }
  const remainingHardTimeoutMs = Math.max(
    1,
    hardTimeoutMs - (Date.now() - startedAt.getTime())
  );

  return new Promise<ExecutionResult>((resolvePromise, rejectPromise) => {
    const child = spawn(options.command[0], options.command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, AGENTDOCTOR_PROTOCOL: "0.1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const lines = createInterface({ input: child.stdout });
    let stdoutBytes = 0;
    let finalReceived = false;
    let settled = false;
    let pendingToolCall: string | undefined;
    const callIds = new Set<string>();
    const toolCallCounts = new Map<string, number>();
    const consumedConfirmations = new Set<number>();

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      void terminateChildProcess(child).finally(() => {
        const message = sanitize(error.message);
        const execution = snapshot();
        rejectPromise(
          error instanceof AgentAuthorizationDeniedError
            ? new AgentAuthorizationDeniedError(message, execution)
            : new AgentExecutionError(message, execution)
        );
      });
    };

    const timeout = setTimeout(() => {
      fail(new Error(`Agent exceeded the hard timeout of ${hardTimeoutMs}ms`));
    }, remainingHardTimeoutMs);

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

    const resolveToolCall = async (
      event: Extract<AgentOutput, { type: "tool_call" }>,
      argumentsValue: Record<string, unknown>,
      callIndex: number
    ) => {
      const mode = options.scenario.enforcement?.preDispatch ? "enforce" : "observe";
      if (mode === "enforce") {
        let denialReason:
          | "tool_forbidden"
          | "confirmation_missing_or_mismatched"
          | undefined;
        if (options.scenario.expect.tools?.forbidden?.includes(event.tool)) {
          denialReason = "tool_forbidden";
        } else if (
          options.scenario.expect.confirmation?.requiredBefore.includes(event.tool)
        ) {
          const confirmation = [...evidence].reverse().find(
            (
              candidate
            ): candidate is Extract<EvidenceEvent, { type: "confirmation" }> =>
              candidate.type === "confirmation" &&
              candidate.confirmed &&
              candidate.tool === event.tool &&
              !consumedConfirmations.has(candidate.sequence) &&
              (!options.scenario.expect.confirmation?.bindArguments ||
                (candidate.arguments !== undefined &&
                  isStructurallyEqual(candidate.arguments, argumentsValue)))
          );
          if (confirmation) {
            consumedConfirmations.add(confirmation.sequence);
          } else {
            denialReason = "confirmation_missing_or_mismatched";
          }
        }

        if (denialReason) {
          record({
            type: "tool_lifecycle",
            callId: event.callId,
            tool: event.tool,
            state: "denied",
            mode,
            reason: denialReason
          });
          throw new AgentAuthorizationDeniedError(
            `Pre-dispatch authorization denied ${event.tool}: ${denialReason}`,
            snapshot()
          );
        }
        record({
          type: "tool_lifecycle",
          callId: event.callId,
          tool: event.tool,
          state: "authorized",
          mode
        });
      }
      let result: unknown;
      if (options.toolBackend) {
        record({
          type: "tool_lifecycle",
          callId: event.callId,
          tool: event.tool,
          state: "dispatched",
          mode
        });
        const resolution = await options.toolBackend.call(event.tool, argumentsValue);
        result = resolution.result;
        record({
          type: "tool_result",
          callId: event.callId,
          tool: event.tool,
          result: resolution.evidenceResult ?? resolution.result,
          source: resolution.source,
          durationMs: resolution.durationMs,
          resultBytes: resolution.resultBytes,
          ...(resolution.isError ? { isError: true } : {})
        });
      } else {
        if (!Object.hasOwn(options.fixtures, event.tool)) {
          throw new Error(`No fixture is configured for tool ${event.tool}`);
        }
        const fixtureCase = options.fixtures[event.tool].cases.find(
          (candidate) =>
            (candidate.callIndex === undefined || candidate.callIndex === callIndex) &&
            (candidate.arguments === undefined ||
              isSubset(candidate.arguments, argumentsValue))
        );
        record({
          type: "tool_lifecycle",
          callId: event.callId,
          tool: event.tool,
          state: "dispatched",
          mode
        });
        if (!fixtureCase) {
          // A real agent will occasionally call a tool with arguments the
          // fixture set does not anticipate. Aborting the run here would turn
          // the instrument off at exactly that moment and hide every defect
          // later in the trace, so record the miss as a tool error and let the
          // remaining expectations evaluate.
          const message = `No fixture case matched ${event.tool} call index ${callIndex} with arguments ${JSON.stringify(argumentsValue)}`;
          result = { error: "fixture_unmatched", message };
          record({
            type: "tool_result",
            callId: event.callId,
            tool: event.tool,
            result,
            source: "fixture",
            isError: true,
            fixtureMiss: true
          });
        } else {
          result = fixtureCase.result;
          record({
            type: "tool_result",
            callId: event.callId,
            tool: event.tool,
            result,
            source: "fixture"
          });
        }
      }
      record({
        type: "tool_lifecycle",
        callId: event.callId,
        tool: event.tool,
        state: "completed",
        mode
      });
      child.stdin.write(
        `${JSON.stringify({
          type: "tool_result",
          callId: event.callId,
          tool: event.tool,
          result
        })}\n`
      );
      pendingToolCall = undefined;
    };

    const handleLine = (line: string) => {
      if (line.trim().length === 0 || settled) return;

      if (finalReceived) {
        throw new Error("Agent emitted output after its final event");
      }
      const event = parseAgentOutput(line);
      if (pendingToolCall) {
        throw new Error(
          `Agent emitted ${event.type} before observing tool result for ${pendingToolCall}`
        );
      }
      if (event.type === "tool_call") {
        if (callIds.has(event.callId)) {
          throw new Error(`Agent reused tool call ID: ${event.callId}`);
        }
        callIds.add(event.callId);
        pendingToolCall = event.callId;
        const argumentsValue = event.arguments ?? {};
        const callIndex = toolCallCounts.get(event.tool) ?? 0;
        toolCallCounts.set(event.tool, callIndex + 1);
        record({
          ...event,
          arguments: argumentsValue
        });
        record({
          type: "tool_lifecycle",
          callId: event.callId,
          tool: event.tool,
          state: "requested",
          mode: options.scenario.enforcement?.preDispatch ? "enforce" : "observe"
        });
        void resolveToolCall(event, argumentsValue, callIndex).catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      record(event);
      if (event.type === "final") {
        finalReceived = true;
        child.stdin.end();
      }
    };

    lines.on("line", (line) => {
      try {
        handleLine(line);
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
      if (pendingToolCall) {
        fail(new Error(`Agent exited before observing tool result for ${pendingToolCall}`));
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolvePromise(snapshot());
    });
  });
}