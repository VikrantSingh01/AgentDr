import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AgentAuthorizationDeniedError,
  AgentExecutionError,
  executeAgentProcess
} from "./agent-process.js";
import {
  evaluateMcpEvidence,
  evaluateObservedPolicies,
  evaluateRun
} from "./evaluator.js";
import { McpStdioProxy } from "./mcp-stdio-proxy.js";
import {
  createRedactor,
  redactRunReport,
  snapshotSafeReportRedaction,
  type RedactionOptions
} from "./redaction.js";
import { writeRunReport } from "./reporter.js";
import { loadScenario } from "./scenario-loader.js";
import type { ToolBackend, ToolBackendFactory } from "./tool-backend.js";
import type {
  CompletedRun,
  Decision,
  ExecutionResult,
  GraphNodeName,
  GraphTransition,
  RunReport,
  ResolvedFixtures,
  Scenario
} from "./types.js";

interface GraphState {
  scenarioPath: string;
  cwd: string;
  outputDirectory: string;
  requestedCommand: string[];
  requestedMcpCommand?: string[];
  toolBackendFactory?: ToolBackendFactory;
  backendRedaction?: RedactionOptions;
  scenario?: Scenario;
  fixtures?: ResolvedFixtures;
  command?: string[];
  execution?: ExecutionResult;
  decision?: Decision;
  report?: RunReport;
  reportPath?: string;
  transitions: GraphTransition[];
}

export interface RunOptions {
  scenarioPath: string;
  command?: string[];
  cwd?: string;
  outputDirectory?: string;
  mcpCommand?: string[];
  toolBackendFactory?: ToolBackendFactory;
}

const graph: Record<GraphNodeName, GraphNodeName | null> = {
  load: "execute",
  execute: "capture",
  capture: "evaluate",
  evaluate: "report",
  report: null
};

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Graph state is missing ${name}`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nestedValue);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedExecution(
  state: GraphState,
  startedAt: Date
): ExecutionResult {
  return {
    command: requireValue(state.command, "command"),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    evidence: [],
    stderr: ""
  };
}

function requireToolBackend(value: unknown): ToolBackend {
  if (
    typeof value !== "object" ||
    value === null ||
    !["start", "call", "close"].every(
      (method) => typeof (value as Record<string, unknown>)[method] === "function"
    )
  ) {
    throw new Error(
      "Tool backend factory must return an object implementing start, call, and close"
    );
  }
  return value as ToolBackend;
}

async function closeBackendCandidate(value: unknown): Promise<void> {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { close?: unknown }).close === "function"
  ) {
    await (value as { close(): Promise<void> }).close();
  }
}

function redactBackendError(backend: ToolBackend, error: unknown): string {
  return String(createRedactor(backend.redaction)(errorMessage(error)));
}

function appendCleanupFailure(
  error: AgentExecutionError,
  detail: string
): AgentExecutionError {
  const message = `${error.message}; tool backend cleanup failed: ${detail}`;
  return error instanceof AgentAuthorizationDeniedError
    ? new AgentAuthorizationDeniedError(message, error.execution)
    : new AgentExecutionError(message, error.execution);
}

async function runNode(node: GraphNodeName, state: GraphState): Promise<void> {
  if (node === "load") {
    const loaded = await loadScenario(state.scenarioPath);
    state.scenario = loaded.scenario;
    state.fixtures = loaded.resolvedFixtures;
    state.command =
      state.requestedCommand.length > 0
        ? state.requestedCommand
        : loaded.scenario.adapter?.command;
    if (!state.command || state.command.length === 0) {
      throw new Error("Provide an agent command after -- or in scenario.adapter.command");
    }
    return;
  }

  if (node === "execute") {
    const scenario = requireValue(state.scenario, "scenario");
    const fixtures = requireValue(state.fixtures, "fixtures");
    const mcpConfiguration = scenario.mcp
      ? {
          ...scenario.mcp,
          server: {
            command:
              state.requestedMcpCommand ?? scenario.mcp.server.command
          }
        }
      : undefined;
    const backendStartedAt = new Date();
    let toolBackend: ToolBackend | undefined;
    let backendCandidate: unknown;
    try {
      if (state.toolBackendFactory && mcpConfiguration) {
        throw new Error(
          "toolBackendFactory cannot be combined with scenario.mcp; choose one dispatch backend"
        );
      }
      if (state.toolBackendFactory) {
        backendCandidate = state.toolBackendFactory({
          scenario: deepFreeze(structuredClone(scenario)),
          fixtures: deepFreeze(structuredClone(fixtures)),
          cwd: state.cwd
        });
        toolBackend = requireToolBackend(backendCandidate);
        state.backendRedaction = snapshotSafeReportRedaction(
          toolBackend.redaction
        );
      } else if (mcpConfiguration) {
        toolBackend = new McpStdioProxy(mcpConfiguration, state.cwd);
      }
    } catch (error) {
      let cleanupDetail = "";
      try {
        await closeBackendCandidate(backendCandidate);
      } catch (closeError) {
        cleanupDetail = `; tool backend cleanup failed: ${errorMessage(closeError)}`;
      }
      throw new AgentExecutionError(
        `Tool backend setup failed: ${errorMessage(error)}${cleanupDetail}`,
        failedExecution(state, backendStartedAt)
      );
    }

    let executionError: unknown;
    try {
      state.execution = await executeAgentProcess({
        scenario,
        fixtures,
        command: requireValue(state.command, "command"),
        cwd: state.cwd,
        toolBackend
      });
    } catch (error) {
      executionError = error;
    }

    if (toolBackend) {
      try {
        await toolBackend.close();
      } catch (closeError) {
        const detail = redactBackendError(toolBackend, closeError);
        if (executionError instanceof AgentExecutionError) {
          throw appendCleanupFailure(executionError, detail);
        }
        if (executionError !== undefined) throw executionError;
        throw new AgentExecutionError(
          `Tool backend cleanup failed: ${detail}`,
          requireValue(state.execution, "execution")
        );
      }
    }

    if (executionError !== undefined) throw executionError;
    return;
  }

  if (node === "capture") {
    const execution = requireValue(state.execution, "execution");
    if (!execution.evidence.some((event) => event.type === "final")) {
      throw new Error("Evidence capture is incomplete: final event is missing");
    }
    return;
  }

  if (node === "evaluate") {
    const execution = requireValue(state.execution, "execution");
    state.decision = evaluateRun(
      requireValue(state.scenario, "scenario"),
      execution.evidence,
      execution.durationMs
    );
    return;
  }

  const scenario = requireValue(state.scenario, "scenario");
  const execution = requireValue(state.execution, "execution");
  state.report = {
    reportVersion: "0.1",
    runId: randomUUID(),
    scenarioId: scenario.id,
    scenarioPath: state.scenarioPath,
    command: requireValue(state.command, "command"),
    startedAt: execution.startedAt,
    durationMs: execution.durationMs,
    graph: state.transitions,
    evidence: execution.evidence,
    decision: requireValue(state.decision, "decision"),
    ...(execution.stderr.trim() ? { stderr: execution.stderr.trim() } : {})
  };
}

export async function runAgentDoctor(options: RunOptions): Promise<CompletedRun> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const state: GraphState = {
    scenarioPath: resolve(cwd, options.scenarioPath),
    cwd,
    outputDirectory: resolve(cwd, options.outputDirectory ?? ".agentdoctor/runs"),
    requestedCommand: options.command ?? [],
    requestedMcpCommand: options.mcpCommand,
    toolBackendFactory: options.toolBackendFactory,
    transitions: []
  };

  let node: GraphNodeName | null = "load";
  while (node) {
    const currentNode: GraphNodeName = node;
    state.transitions.push({
      node: currentNode,
      status: "started",
      timestamp: new Date().toISOString()
    });
    try {
      await runNode(currentNode, state);
      state.transitions.push({
        node: currentNode,
        status: "completed",
        timestamp: new Date().toISOString()
      });
      node = graph[currentNode];
    } catch (error) {
      state.transitions.push({
        node: currentNode,
        status: "failed",
        timestamp: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error)
      });

      if (currentNode === "execute" && error instanceof AgentExecutionError) {
        state.execution = error.execution;
        const partialFindings = [
          ...evaluateMcpEvidence(
            requireValue(state.scenario, "scenario"),
            error.execution.evidence
          ),
          ...evaluateObservedPolicies(
            requireValue(state.scenario, "scenario"),
            error.execution.evidence
          )
        ];
        const authorizationDenied = error instanceof AgentAuthorizationDeniedError;
        state.decision = {
          status: authorizationDenied ? "failed" : "runtime_failed",
          exitCode: authorizationDenied
            ? 3
            : partialFindings.some((finding) => finding.severity === "critical")
              ? 3
              : 2,
          findings: authorizationDenied
            ? partialFindings
            : [
                ...partialFindings,
                {
                  id: "runtime.execution",
                  severity: "error",
                  message: error.message,
                  ...(error.execution.evidence.length > 0
                    ? {
                        evidenceSequence:
                          error.execution.evidence[
                            error.execution.evidence.length - 1
                          ].sequence
                      }
                    : {})
                }
              ]
        };
        state.transitions.push({
          node: "report",
          status: "started",
          timestamp: new Date().toISOString()
        });
        await runNode("report", state);
        state.transitions.push({
          node: "report",
          status: "completed",
          timestamp: new Date().toISOString()
        });
        break;
      }
      throw error;
    }
  }

  const report = redactRunReport(
    requireValue(state.report, "report"),
    state.scenario?.mcp?.redaction ?? state.backendRedaction
  );
  state.report = report;
  state.reportPath = await writeRunReport(report, state.outputDirectory);

  return {
    report,
    reportPath: requireValue(state.reportPath, "report path")
  };
}