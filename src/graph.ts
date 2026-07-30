import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AgentExecutionError, executeAgentProcess } from "./agent-process.js";
import { evaluateRun } from "./evaluator.js";
import { writeRunReport } from "./reporter.js";
import { loadScenario } from "./scenario-loader.js";
import type {
  CompletedRun,
  Decision,
  ExecutionResult,
  GraphNodeName,
  GraphTransition,
  RunReport,
  Scenario
} from "./types.js";

interface GraphState {
  scenarioPath: string;
  cwd: string;
  outputDirectory: string;
  requestedCommand: string[];
  scenario?: Scenario;
  fixtures?: Record<string, unknown>;
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

async function runNode(node: GraphNodeName, state: GraphState): Promise<void> {
  if (node === "load") {
    const loaded = await loadScenario(state.scenarioPath);
    state.scenario = loaded.scenario;
    state.fixtures = loaded.fixtures;
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
    state.execution = await executeAgentProcess({
      scenario: requireValue(state.scenario, "scenario"),
      fixtures: requireValue(state.fixtures, "fixtures"),
      command: requireValue(state.command, "command"),
      cwd: state.cwd
    });
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
        state.decision = {
          status: "runtime_failed",
          exitCode: 2,
          findings: [
            {
              id: "runtime.execution",
              severity: "error",
              message: error.message,
              ...(error.execution.evidence.length > 0
                ? {
                    evidenceSequence:
                      error.execution.evidence[error.execution.evidence.length - 1].sequence
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

  const report = requireValue(state.report, "report");
  state.reportPath = await writeRunReport(report, state.outputDirectory);

  return {
    report,
    reportPath: requireValue(state.reportPath, "report path")
  };
}