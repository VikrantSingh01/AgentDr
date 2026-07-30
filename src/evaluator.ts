import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  Decision,
  EvidenceEvent,
  Finding,
  Scenario
} from "./types.js";

function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual);
  }
  if (actual === null || typeof actual !== "object") return false;

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isSubset(value, actual[index]))
    );
  }

  return Object.entries(expected).every(([key, value]) =>
    isSubset(value, (actual as Record<string, unknown>)[key])
  );
}

export function evaluateRun(
  scenario: Scenario,
  evidence: EvidenceEvent[],
  durationMs: number
): Decision {
  const findings: Finding[] = [];
  const calls = evidence.filter((event) => event.type === "tool_call");
  const callNames = calls.map((event) => event.tool);
  const expectations = scenario.expect.tools;

  for (const tool of expectations?.required ?? []) {
    if (!callNames.includes(tool)) {
      findings.push({
        id: "tool.required",
        severity: "error",
        message: `Required tool was not called: ${tool}`
      });
    }
  }

  for (const tool of expectations?.forbidden ?? []) {
    const call = calls.find((event) => event.tool === tool);
    if (call) {
      findings.push({
        id: "tool.forbidden",
        severity: "critical",
        message: `Forbidden tool was called: ${tool}`,
        evidenceSequence: call.sequence
      });
    }
  }

  if (expectations?.maxCalls !== undefined && calls.length > expectations.maxCalls) {
    findings.push({
      id: "tool.max_calls",
      severity: "error",
      message: `Tool call budget exceeded: observed ${calls.length}, maximum ${expectations.maxCalls}`
    });
  }

  if (expectations?.order) {
    let previousIndex = -1;
    for (const tool of expectations.order) {
      const nextIndex = callNames.indexOf(tool, previousIndex + 1);
      if (nextIndex === -1) {
        findings.push({
          id: "tool.order",
          severity: "error",
          message: `Expected tool order was not observed: ${expectations.order.join(" -> ")}`
        });
        break;
      }
      previousIndex = nextIndex;
    }
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const argumentExpectation of expectations?.arguments ?? []) {
    const matchingCalls = calls.filter((event) => event.tool === argumentExpectation.tool);
    for (const call of matchingCalls) {
      if (
        argumentExpectation.match &&
        !isSubset(argumentExpectation.match, call.arguments)
      ) {
        findings.push({
          id: "tool.arguments_subset",
          severity: "error",
          message: `Arguments for ${call.tool} did not contain the expected values`,
          evidenceSequence: call.sequence
        });
      }
      if (argumentExpectation.schema) {
        const validate = ajv.compile(argumentExpectation.schema);
        if (!validate(call.arguments)) {
          findings.push({
            id: "tool.arguments_schema",
            severity: "error",
            message: `Arguments for ${call.tool} failed JSON Schema validation`,
            evidenceSequence: call.sequence
          });
        }
      }
    }
  }

  for (const tool of scenario.expect.confirmation?.requiredBefore ?? []) {
    let previousCallSequence = 0;
    for (const call of calls.filter((event) => event.tool === tool)) {
      const confirmed = evidence.some(
        (event) =>
          event.type === "confirmation" &&
          event.confirmed &&
          event.tool === tool &&
          event.sequence > previousCallSequence &&
          event.sequence < call.sequence
      );
      if (!confirmed) {
        findings.push({
          id: "safety.confirmation_required",
          severity: "critical",
          message: `${tool} was called without prior confirmation`,
          evidenceSequence: call.sequence
        });
      }
      previousCallSequence = call.sequence;
    }
  }

  const final = [...evidence].reverse().find((event) => event.type === "final");
  if (scenario.expect.outcome && final?.status !== scenario.expect.outcome.status) {
    findings.push({
      id: "outcome.status",
      severity: "error",
      message: `Expected final status ${scenario.expect.outcome.status}, observed ${final?.status ?? "none"}`,
      evidenceSequence: final?.sequence
    });
  }

  if (
    scenario.performance?.maxDurationMs !== undefined &&
    durationMs > scenario.performance.maxDurationMs
  ) {
    findings.push({
      id: "performance.duration",
      severity: "error",
      message: `Duration budget exceeded: observed ${durationMs}ms, maximum ${scenario.performance.maxDurationMs}ms`
    });
  }

  const hasCritical = findings.some((finding) => finding.severity === "critical");
  return {
    status: findings.length === 0 ? "passed" : "failed",
    exitCode: findings.length === 0 ? 0 : hasCritical ? 3 : 1,
    findings
  };
}