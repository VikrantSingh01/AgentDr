import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  Decision,
  EvidenceEvent,
  Finding,
  Scenario
} from "./types.js";
import { isStructurallyEqual, isSubset } from "./value-match.js";
import { matchWithReferences, readValueAtPath } from "./result-reference.js";

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
  const final = [...evidence].reverse().find((event) => event.type === "final");

  for (const event of evidence) {
    if (event.type !== "tool_result" || !event.fixtureMiss) continue;
    findings.push({
      id: "fixture.unmatched_call",
      severity: "error",
      message: `No fixture case matched ${event.tool}; the call was answered with an error so the rest of the run could still be evaluated`,
      evidenceSequence: event.sequence
    });
  }

  for (const entry of expectations?.required ?? []) {
    if (typeof entry === "string") {
      if (!callNames.includes(entry)) {
        findings.push({
          id: "tool.required",
          severity: "error",
          message: `Required tool was not called: ${entry}`
        });
      }
      continue;
    }

    const called = callNames.includes(entry.tool);
    const target = final
      ? readValueAtPath(final.output, entry.when.outcomePath)
      : { found: false, value: undefined };

    if (!target.found) {
      findings.push({
        id: "tool.condition_unresolved",
        severity: "error",
        message: `Conditional requirement for ${entry.tool} reads final output path ${entry.when.outcomePath}, which was not reported`,
        evidenceSequence: final?.sequence
      });
      continue;
    }

    let holds: boolean;
    let described: string;
    if (entry.when.nonEmpty === true) {
      if (!Array.isArray(target.value)) {
        findings.push({
          id: "tool.condition_unresolved",
          severity: "error",
          message: `Conditional requirement for ${entry.tool} expects final output path ${entry.when.outcomePath} to be an array`,
          evidenceSequence: final?.sequence
        });
        continue;
      }
      holds = target.value.length > 0;
      described = `${entry.when.outcomePath} is non-empty`;
    } else {
      holds = isStructurallyEqual(entry.when.equals, target.value);
      described = `${entry.when.outcomePath} is ${JSON.stringify(entry.when.equals)}`;
    }

    if (holds && !called) {
      findings.push({
        id: "tool.required_when",
        severity: "error",
        message: `${entry.tool} is required when ${described}, but it was never called`,
        evidenceSequence: final?.sequence
      });
    } else if (!holds && called) {
      // The agent took the action and then reported that it had not. That is a
      // silent divergence on a consequential call, so it is a finding in its
      // own right rather than merely a relaxed obligation.
      findings.push({
        id: "tool.forbidden_when",
        severity: "error",
        message: `${entry.tool} was called, but the final output does not report ${described}`,
        evidenceSequence: final?.sequence
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

  for (const budget of expectations?.budgets ?? []) {
    const observed = callNames.filter((name) => name === budget.tool).length;
    if (budget.maxCalls !== undefined && observed > budget.maxCalls) {
      findings.push({
        id: "tool.max_calls_per_tool",
        severity: "error",
        message: `Call budget for ${budget.tool} exceeded: observed ${observed}, maximum ${budget.maxCalls}`
      });
    }
    if (budget.minCalls !== undefined && observed < budget.minCalls) {
      findings.push({
        id: "tool.min_calls_per_tool",
        severity: "error",
        message: `Call floor for ${budget.tool} not met: observed ${observed}, minimum ${budget.minCalls}`
      });
    }
    if (budget.callsMatchOutcome !== undefined) {
      const target = final
        ? readValueAtPath(final.output, budget.callsMatchOutcome)
        : { found: false, value: undefined };
      if (!target.found || !Array.isArray(target.value)) {
        findings.push({
          id: "tool.calls_outcome_unresolved",
          severity: "error",
          message: `Call budget for ${budget.tool} references final output path ${budget.callsMatchOutcome}, which is not an observed array`,
          evidenceSequence: final?.sequence
        });
      } else if (target.value.length !== observed) {
        findings.push({
          id: "tool.calls_outcome_mismatch",
          severity: "error",
          message: `${budget.tool} was called ${observed} time(s) but the final output reports ${target.value.length} entr(ies) at ${budget.callsMatchOutcome}`,
          evidenceSequence: final?.sequence
        });
      }
    }
  }

  for (const rule of expectations?.precedence ?? []) {
    const beforeIndexes: number[] = [];
    const afterIndexes: number[] = [];
    callNames.forEach((name, index) => {
      if (name === rule.before) beforeIndexes.push(index);
      if (name === rule.after) afterIndexes.push(index);
    });
    if (beforeIndexes.length === 0 || afterIndexes.length === 0) continue;
    const lastBefore = beforeIndexes[beforeIndexes.length - 1]!;
    const firstAfter = afterIndexes[0]!;
    if (lastBefore > firstAfter) {
      findings.push({
        id: "tool.precedence",
        severity: "error",
        message: `Every ${rule.before} call must precede every ${rule.after} call, but ${rule.before} was called after ${rule.after}`,
        evidenceSequence: calls[lastBefore]?.sequence
      });
    }
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
    const toolCalls = calls.filter((event) => event.tool === argumentExpectation.tool);
    const matchingCalls =
      argumentExpectation.callIndex === undefined
        ? toolCalls
        : toolCalls.slice(
            argumentExpectation.callIndex,
            argumentExpectation.callIndex + 1
          );
    if (argumentExpectation.callIndex !== undefined && matchingCalls.length === 0) {
      findings.push({
        id: "tool.arguments_call_missing",
        severity: "error",
        message: `Argument expectation for ${argumentExpectation.tool} targets call index ${argumentExpectation.callIndex}, which was not observed`
      });
      continue;
    }
    for (const call of matchingCalls) {
      if (argumentExpectation.match) {
        const outcome = matchWithReferences(
          argumentExpectation.match,
          call.arguments,
          evidence,
          call.sequence,
          final?.output
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
    for (const path of argumentExpectation.distinct ?? []) {
      const seen = new Map<string, number>();
      for (const call of matchingCalls) {
        const read = readValueAtPath(call.arguments, path);
        if (!read.found) {
          findings.push({
            id: "tool.arguments_distinct_missing",
            severity: "error",
            message: `Uniqueness expectation for ${argumentExpectation.tool} references argument ${path}, which was not present on every call`,
            evidenceSequence: call.sequence
          });
          continue;
        }
        const key = JSON.stringify(read.value ?? null);
        const previous = seen.get(key);
        if (previous !== undefined) {
          findings.push({
            id: "tool.arguments_not_distinct",
            severity: "error",
            message: `Argument ${path} for ${argumentExpectation.tool} must be unique across calls, but ${key} was used more than once`,
            evidenceSequence: call.sequence
          });
        } else {
          seen.set(key, call.sequence);
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

  if (scenario.expect.outcome && final?.status !== scenario.expect.outcome.status) {
    findings.push({
      id: "outcome.status",
      severity: "error",
      message: `Expected final status ${scenario.expect.outcome.status}, observed ${final?.status ?? "none"}`,
      evidenceSequence: final?.sequence
    });
  }
  if (final && scenario.expect.outcome?.match !== undefined) {
    // The outcome is matched with the same reference resolver used for tool
    // arguments, so a contract can say the reported summary must agree with
    // what the tools actually returned instead of pinning it to the literals
    // one baseline run happened to produce.
    const outcome = matchWithReferences(
      scenario.expect.outcome.match,
      final.output,
      evidence,
      final.sequence
    );
    if (outcome.unresolved.length > 0) {
      findings.push({
        id: "outcome.reference_unresolved",
        severity: "error",
        message: `Final output expectation references a result that was not observed: ${outcome.unresolved.join(", ")}`,
        evidenceSequence: final.sequence
      });
    } else if (!outcome.matched) {
      findings.push({
        id: "outcome.output_subset",
        severity: "error",
        message: "Final output did not contain the expected values",
        evidenceSequence: final.sequence
      });
    }
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
  "tool.max_calls_per_tool",
  "tool.precedence",
  "tool.arguments_subset",
  "tool.arguments_schema",
  "tool.arguments_not_distinct",
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