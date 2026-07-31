import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  Decision,
  EvidenceEvent,
  Finding,
  Scenario
} from "./types.js";
import { isStructurallyEqual, isSubset } from "./value-match.js";
import { matchWithReferences } from "./result-reference.js";

export function evaluateMcpEvidence(
  scenario: Scenario,
  evidence: EvidenceEvent[]
): Finding[] {
  if (!scenario.mcp) return [];

  const findings: Finding[] = [];
  const discovery = evidence.find((event) => event.type === "mcp_discovery");
  if (!discovery) {
    findings.push({
      id: "mcp.discovery_missing",
      severity: "error",
      message: "MCP tool discovery evidence is missing"
    });
  } else {
    if (
      scenario.mcp.capabilitySnapshot &&
      discovery.capabilitySnapshotMatches === false
    ) {
      findings.push({
        id: "mcp.capability_drift",
        severity: "error",
        message: "MCP server capability snapshot drift detected",
        evidenceSequence: discovery.sequence
      });
    }
    if (
      Array.isArray(scenario.mcp.toolSnapshot) &&
      discovery.toolSnapshotMatches === false
    ) {
      findings.push({
        id: "mcp.schema_drift",
        severity: "error",
        message: `MCP tool snapshot drift detected${
          (discovery.driftedTools?.length ?? 0) > 0
            ? `: ${discovery.driftedTools!.join(", ")}`
            : ""
        }`,
        evidenceSequence: discovery.sequence
      });
    }
  }

  const mcpResults = evidence.filter(
    (event): event is Extract<EvidenceEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.source === "mcp"
  );
  for (const result of mcpResults) {
    if (result.isError) {
      findings.push({
        id: "mcp.tool_error",
        severity: "error",
        message: `MCP tool returned an error: ${result.tool}`,
        evidenceSequence: result.sequence
      });
    }
    if (
      scenario.mcp.maxResponseBytes !== undefined &&
      (result.resultBytes ?? 0) > scenario.mcp.maxResponseBytes
    ) {
      findings.push({
        id: "mcp.response_size",
        severity: "error",
        message: `MCP result payload from ${result.tool} exceeded ${scenario.mcp.maxResponseBytes} bytes: ${result.resultBytes}`,
        evidenceSequence: result.sequence
      });
    }
    if (
      scenario.mcp.maxToolDurationMs !== undefined &&
      (result.durationMs ?? 0) > scenario.mcp.maxToolDurationMs
    ) {
      findings.push({
        id: "mcp.tool_duration",
        severity: "error",
        message: `MCP call to ${result.tool} exceeded ${scenario.mcp.maxToolDurationMs}ms: ${result.durationMs}ms`,
        evidenceSequence: result.sequence
      });
    }
  }
  return findings;
}

export function evaluateRun(
  scenario: Scenario,
  evidence: EvidenceEvent[],
  durationMs: number
): Decision {
  const findings: Finding[] = evaluateMcpEvidence(scenario, evidence);
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
    for (const call of calls.filter((event) => event.tool === tool)) {
      const denied = evidence.some(
          (event) =>
            event.type === "tool_lifecycle" &&
            event.callId === call.callId &&
            event.state === "denied"
        );
      if (denied) continue;
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
      if (argumentExpectation.match) {
        const outcome = matchWithReferences(
          argumentExpectation.match,
          call.arguments,
          evidence,
          call.sequence
        );
        if (outcome.unresolved.length > 0) {
          findings.push({
            id: "tool.arguments_reference_unresolved",
            severity: "error",
            message: `Arguments for ${call.tool} reference a prior result that was not observed: ${outcome.unresolved.join(", ")}`,
            evidenceSequence: call.sequence
          });
        } else if (!outcome.matched) {
          findings.push({
            id: "tool.arguments_subset",
            severity: "error",
            message: `Arguments for ${call.tool} did not contain the expected values`,
            evidenceSequence: call.sequence
          });
        }
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
    const consumedConfirmations = new Set<number>();
    for (const call of calls.filter((event) => event.tool === tool)) {
      const denied = evidence.some(
        (event) =>
          event.type === "tool_lifecycle" &&
          event.callId === call.callId &&
          event.state === "denied"
      );
      if (denied) continue;

      const confirmation = [...evidence].reverse().find(
        (
          event
        ): event is Extract<EvidenceEvent, { type: "confirmation" }> =>
          event.type === "confirmation" &&
          event.confirmed &&
          event.tool === tool &&
          event.sequence < call.sequence &&
          !consumedConfirmations.has(event.sequence) &&
          (!scenario.expect.confirmation?.bindArguments ||
            (event.arguments !== undefined &&
              isStructurallyEqual(event.arguments, call.arguments)))
      );
      if (confirmation) {
        consumedConfirmations.add(confirmation.sequence);
      } else {
        findings.push({
          id: "safety.confirmation_required",
          severity: "critical",
          message: `${tool} was called without prior confirmation`,
          evidenceSequence: call.sequence
        });
      }
    }
  }

  for (const denied of evidence.filter(
    (
      event
    ): event is Extract<EvidenceEvent, { type: "tool_lifecycle" }> =>
      event.type === "tool_lifecycle" && event.state === "denied"
  )) {
    findings.push({
      id: "dispatch.authorization_denied",
      severity: "critical",
      message: `Pre-dispatch authorization denied ${denied.tool}: ${denied.reason}`,
      evidenceSequence: denied.sequence
    });
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
    final &&
    scenario.expect.outcome?.match !== undefined &&
    !isSubset(scenario.expect.outcome.match, final.output)
  ) {
    findings.push({
      id: "outcome.output_subset",
      severity: "error",
      message: "Final output did not contain the expected values",
      evidenceSequence: final.sequence
    });
  }
  if (final && scenario.expect.outcome?.schema) {
    const validate = ajv.compile(scenario.expect.outcome.schema);
    if (!validate(final.output)) {
      findings.push({
        id: "outcome.output_schema",
        severity: "error",
        message: "Final output failed JSON Schema validation",
        evidenceSequence: final.sequence
      });
    }
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

const PARTIAL_TRACE_FINDINGS = new Set([
  "tool.forbidden",
  "tool.max_calls",
  "tool.arguments_subset",
  "tool.arguments_schema",
  "safety.confirmation_required",
  "dispatch.authorization_denied"
]);

export function evaluateObservedPolicies(
  scenario: Scenario,
  evidence: EvidenceEvent[]
): Finding[] {
  return evaluateRun(scenario, evidence, 0).findings.filter((finding) =>
    PARTIAL_TRACE_FINDINGS.has(finding.id)
  );
}