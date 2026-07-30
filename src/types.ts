export type Severity = "error" | "critical";

export interface Scenario {
  schemaVersion: "0.1";
  id: string;
  input: {
    message: string;
    data?: unknown;
  };
  fixtures?: Record<string, unknown>;
  adapter?: {
    command: string[];
  };
  expect: {
    tools?: {
      required?: string[];
      forbidden?: string[];
      order?: string[];
      maxCalls?: number;
      arguments?: Array<{
        tool: string;
        match?: Record<string, unknown>;
        schema?: Record<string, unknown>;
      }>;
    };
    confirmation?: {
      requiredBefore: string[];
    };
    outcome?: {
      status: string;
      match?: unknown;
      schema?: Record<string, unknown>;
    };
  };
  performance?: {
    maxDurationMs?: number;
  };
}

interface EvidenceBase {
  sequence: number;
  timestamp: string;
}

export type EvidenceEvent =
  | (EvidenceBase & {
      type: "tool_call";
      callId: string;
      tool: string;
      arguments: Record<string, unknown>;
    })
  | (EvidenceBase & {
      type: "tool_result";
      callId: string;
      tool: string;
      result: unknown;
    })
  | (EvidenceBase & {
      type: "confirmation";
      confirmed: boolean;
      tool: string;
      source?: string;
    })
  | (EvidenceBase & {
      type: "final";
      status: string;
      output?: unknown;
    });

export interface ExecutionResult {
  command: string[];
  startedAt: string;
  durationMs: number;
  evidence: EvidenceEvent[];
  stderr: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  evidenceSequence?: number;
}

export interface Decision {
  status: "passed" | "failed" | "runtime_failed";
  exitCode: 0 | 1 | 2 | 3;
  findings: Finding[];
}

export type GraphNodeName =
  | "load"
  | "execute"
  | "capture"
  | "evaluate"
  | "report";

export interface GraphTransition {
  node: GraphNodeName;
  status: "started" | "completed" | "failed";
  timestamp: string;
  detail?: string;
}

export interface RunReport {
  reportVersion: "0.1";
  runId: string;
  scenarioId: string;
  scenarioPath: string;
  command: string[];
  startedAt: string;
  durationMs: number;
  graph: GraphTransition[];
  evidence: EvidenceEvent[];
  decision: Decision;
  stderr?: string;
}

export interface CompletedRun {
  report: RunReport;
  reportPath: string;
}