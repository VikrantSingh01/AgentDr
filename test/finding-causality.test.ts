import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

const reportSchema = {
  type: "object",
  required: ["routed"],
  properties: { routed: { type: "array" } }
} as const;

function scenario(overrides: Partial<Scenario["expect"]> = {}): Scenario {
  return {
    id: "causality",
    agent: { command: ["node", "agent.js"] },
    fixtures: {},
    expect: {
      outcome: { status: "completed", schema: reportSchema as never },
      ...overrides
    }
  } as Scenario;
}

function evidence(output: unknown, calls: Array<{ tool: string; args: unknown }> = []): EvidenceEvent[] {
  const events: EvidenceEvent[] = [];
  let sequence = 1;
  for (const call of calls) {
    events.push({
      type: "tool_call",
      tool: call.tool,
      arguments: call.args,
      sequence: sequence++,
      timestamp: new Date().toISOString()
    } as EvidenceEvent);
    events.push({
      type: "tool_result",
      tool: call.tool,
      result: {},
      sequence: sequence++,
      timestamp: new Date().toISOString()
    } as EvidenceEvent);
  }
  events.push({
    type: "final",
    status: "completed",
    output,
    sequence: sequence++,
    timestamp: new Date().toISOString()
  } as EvidenceEvent);
  return events;
}

describe("finding causality", () => {
  it("attributes an unreadable condition to the schema failure that explains it", () => {
    const decision = evaluateRun(
      scenario({
        outcome: { status: "completed", schema: reportSchema as never },
        tools: { required: [{ tool: "teams.post", when: { outcomePath: "routed", nonEmpty: true } }] }
      }),
      evidence({ assistantText: "" }),
      10
    );

    const condition = decision.findings.find((f) => f.id === "tool.condition_unresolved");
    expect(condition?.causedBy).toBe("outcome.output_schema");
    expect(decision.findings.some((f) => f.id === "outcome.output_schema")).toBe(true);
  });

  it("leaves the root cause itself unattributed", () => {
    const decision = evaluateRun(scenario(), evidence({ assistantText: "" }), 10);
    const root = decision.findings.find((f) => f.id === "outcome.output_schema");
    expect(root).toBeDefined();
    expect(root?.causedBy).toBeUndefined();
  });

  it("does not attribute anything when the report satisfies its schema", () => {
    const decision = evaluateRun(
      scenario({
        outcome: { status: "completed", schema: reportSchema as never },
        tools: { required: [{ tool: "teams.post", when: { outcomePath: "routed", nonEmpty: true } }] }
      }),
      evidence({ routed: ["BUG-1"] }),
      10
    );

    expect(decision.findings.every((f) => f.causedBy === undefined)).toBe(true);
    expect(decision.findings.some((f) => f.id === "tool.required_when")).toBe(true);
  });

  it("keeps every finding and the failing verdict; attribution is not suppression", () => {
    const withSchema = evaluateRun(
      scenario({
        outcome: { status: "completed", schema: reportSchema as never },
        tools: {
          required: [{ tool: "teams.post", when: { outcomePath: "routed", nonEmpty: true } }],
          budgets: [{ tool: "ado.update", callsMatchOutcome: "routed" }]
        }
      }),
      evidence({ assistantText: "" }),
      10
    );

    expect(withSchema.status).toBe("failed");
    expect(withSchema.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "tool.condition_unresolved",
        "tool.calls_outcome_unresolved",
        "outcome.output_schema"
      ])
    );
    const derived = withSchema.findings.filter((f) => f.causedBy === "outcome.output_schema");
    expect(derived).toHaveLength(2);
  });

  it("attributes an outcome mismatch to the schema failure", () => {
    const decision = evaluateRun(
      scenario({
        outcome: {
          status: "completed",
          schema: reportSchema as never,
          match: { routed: ["BUG-1"] }
        }
      }),
      evidence({ assistantText: "" }),
      10
    );

    expect(decision.findings.find((f) => f.id === "outcome.output_subset")?.causedBy).toBe(
      "outcome.output_schema"
    );
  });

  it("does not attribute a $fromResult reference, which does not read the report", () => {
    const decision = evaluateRun(
      scenario({
        outcome: { status: "completed", schema: reportSchema as never },
        tools: {
          arguments: [
            {
              tool: "ado.update",
              match: { id: { $fromResult: { tool: "ado.query", select: "missing" } } }
            }
          ]
        }
      }),
      evidence({ assistantText: "" }, [{ tool: "ado.update", args: { id: "BUG-1" } }]),
      10
    );

    const reference = decision.findings.find((f) => f.id === "tool.arguments_reference_unresolved");
    expect(reference).toBeDefined();
    expect(reference?.causedBy).toBeUndefined();
  });

  it("attributes a $fromOutcome reference, which does read the report", () => {
    const decision = evaluateRun(
      scenario({
        outcome: { status: "completed", schema: reportSchema as never },
        tools: {
          arguments: [
            { tool: "ecs.advance", match: { ring: { $fromOutcome: "ringAdvance.toRing" } } }
          ]
        }
      }),
      evidence({ assistantText: "" }, [{ tool: "ecs.advance", args: { ring: 2 } }]),
      10
    );

    expect(
      decision.findings.find((f) => f.id === "tool.arguments_reference_unresolved")?.causedBy
    ).toBe("outcome.output_schema");
  });

  it("attributes nothing when the contract declares no outcome schema", () => {
    const decision = evaluateRun(
      {
        id: "no-schema",
        agent: { command: ["node", "agent.js"] },
        fixtures: {},
        expect: {
          tools: { required: [{ tool: "teams.post", when: { outcomePath: "routed", nonEmpty: true } }] }
        }
      } as Scenario,
      evidence({ assistantText: "" }),
      10
    );

    expect(decision.findings.find((f) => f.id === "tool.condition_unresolved")?.causedBy).toBeUndefined();
  });
});
