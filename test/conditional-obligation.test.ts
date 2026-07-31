import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/evaluator.js";
import { lintScenario } from "../src/scenario-linter.js";
import type { EvidenceEvent, Scenario } from "../src/types.js";

function scenarioWith(required: Scenario["expect"]["tools"] extends infer T
  ? T extends { required?: infer R }
    ? R
    : never
  : never): Scenario {
  return {
    schema: "agentdoctor/scenario@0.1",
    id: "conditional",
    prompt: "triage",
    fixtures: {},
    expect: { tools: { required } }
  } as Scenario;
}

function evidenceFor(options: {
  calls: string[];
  output: unknown;
}): EvidenceEvent[] {
  const events: EvidenceEvent[] = options.calls.map((tool, index) => ({
    type: "tool_call",
    sequence: index + 1,
    timestamp: index,
    callId: `c${index}`,
    tool,
    arguments: {}
  }));
  events.push({
    type: "final",
    sequence: options.calls.length + 1,
    timestamp: options.calls.length,
    output: options.output
  });
  return events;
}

const escalationRequired = scenarioWith([
  "ado.query_untriaged_bugs",
  { tool: "teams.post_escalation", when: { outcomePath: "escalated", equals: true } }
]);

describe("conditional obligation", () => {
  it("does not demand the tool in worlds where the condition does not hold", () => {
    const result = evaluateRun(
      escalationRequired,
      evidenceFor({ calls: ["ado.query_untriaged_bugs"], output: { escalated: false } }),
      1
    );
    expect(result.findings.map((finding) => finding.id)).toEqual([]);
  });

  it("demands the tool when the condition holds", () => {
    const result = evaluateRun(
      escalationRequired,
      evidenceFor({ calls: ["ado.query_untriaged_bugs"], output: { escalated: true } }),
      1
    );
    const finding = result.findings.find((entry) => entry.id === "tool.required_when");
    expect(finding?.message).toContain("teams.post_escalation");
    expect(finding?.message).toContain("escalated is true");
  });

  it("accepts the tool when the condition holds and it was called", () => {
    const result = evaluateRun(
      escalationRequired,
      evidenceFor({
        calls: ["ado.query_untriaged_bugs", "teams.post_escalation"],
        output: { escalated: true }
      }),
      1
    );
    expect(result.findings).toEqual([]);
  });

  it("reports an action the agent took but did not report taking", () => {
    const result = evaluateRun(
      escalationRequired,
      evidenceFor({
        calls: ["ado.query_untriaged_bugs", "teams.post_escalation"],
        output: { escalated: false }
      }),
      1
    );
    const finding = result.findings.find((entry) => entry.id === "tool.forbidden_when");
    expect(finding?.message).toContain("does not report escalated is true");
  });

  it("never passes vacuously when the referenced outcome path is missing", () => {
    const result = evaluateRun(
      escalationRequired,
      evidenceFor({ calls: ["ado.query_untriaged_bugs"], output: { reviewed: 4 } }),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toContain("tool.condition_unresolved");
  });

  it("never passes vacuously when there is no final output at all", () => {
    const result = evaluateRun(escalationRequired, [], 1);
    expect(result.findings.map((entry) => entry.id)).toContain("tool.condition_unresolved");
  });

  it("resolves nested outcome paths", () => {
    const scenario = scenarioWith([
      {
        tool: "ecs.advance_rollout_ring",
        when: { outcomePath: "ringAdvance.attempted", equals: true }
      }
    ]);
    const missing = evaluateRun(
      scenario,
      evidenceFor({ calls: [], output: { ringAdvance: { attempted: true } } }),
      1
    );
    expect(missing.findings.map((entry) => entry.id)).toEqual(["tool.required_when"]);

    const held = evaluateRun(
      scenario,
      evidenceFor({ calls: [], output: { ringAdvance: { attempted: false } } }),
      1
    );
    expect(held.findings).toEqual([]);
  });

  it("supports a non-empty predicate over reported collections", () => {
    const scenario = scenarioWith([
      { tool: "ado.get_area_owner", when: { outcomePath: "routed", nonEmpty: true } }
    ]);
    expect(
      evaluateRun(scenario, evidenceFor({ calls: [], output: { routed: [] } }), 1).findings
    ).toEqual([]);
    expect(
      evaluateRun(scenario, evidenceFor({ calls: [], output: { routed: [{ id: 1 }] } }), 1)
        .findings.map((entry) => entry.id)
    ).toEqual(["tool.required_when"]);
  });

  it("reports a non-empty predicate pointed at a non-array", () => {
    const scenario = scenarioWith([
      { tool: "ado.get_area_owner", when: { outcomePath: "routed", nonEmpty: true } }
    ]);
    const result = evaluateRun(
      scenario,
      evidenceFor({ calls: [], output: { routed: 3 } }),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual(["tool.condition_unresolved"]);
  });

  it("distinguishes a false condition from an absent one", () => {
    const absent = evaluateRun(
      escalationRequired,
      evidenceFor({ calls: ["ado.query_untriaged_bugs"], output: {} }),
      1
    );
    expect(absent.findings.map((entry) => entry.id)).toEqual(["tool.condition_unresolved"]);
  });

  it("still enforces plain string requirements alongside conditional ones", () => {
    const result = evaluateRun(
      escalationRequired,
      evidenceFor({ calls: [], output: { escalated: false } }),
      1
    );
    expect(result.findings.map((entry) => entry.id)).toEqual(["tool.required"]);
  });
});

describe("conditional obligation linter", () => {
  it("rejects a condition that states neither equals nor nonEmpty", () => {
    const errors = lintScenario(
      scenarioWith([{ tool: "teams.post_escalation", when: { outcomePath: "escalated" } }]),
      {}
    );
    expect(errors.join("\n")).toContain("must declare either equals or nonEmpty");
  });

  it("rejects a condition that combines equals with nonEmpty", () => {
    const errors = lintScenario(
      scenarioWith([
        {
          tool: "teams.post_escalation",
          when: { outcomePath: "routed", equals: true, nonEmpty: true }
        }
      ]),
      {}
    );
    expect(errors.join("\n")).toContain("cannot combine equals with nonEmpty");
  });

  it("rejects nonEmpty set to false because it states no condition", () => {
    const errors = lintScenario(
      scenarioWith([
        { tool: "teams.post_escalation", when: { outcomePath: "routed", nonEmpty: false } }
      ]),
      {}
    );
    expect(errors.join("\n")).toContain("states no condition");
  });

  it("rejects a tool that is both unconditionally and conditionally required", () => {
    const errors = lintScenario(
      scenarioWith([
        "teams.post_escalation",
        { tool: "teams.post_escalation", when: { outcomePath: "escalated", equals: true } }
      ]),
      {}
    );
    expect(errors.join("\n")).toContain("can never relax the obligation");
  });

  it("rejects a conditionally required tool that is also forbidden", () => {
    const scenario = {
      schema: "agentdoctor/scenario@0.1",
      id: "conditional",
      prompt: "triage",
      fixtures: {},
      expect: {
        tools: {
          required: [
            { tool: "teams.post_escalation", when: { outcomePath: "escalated", equals: true } }
          ],
          forbidden: ["teams.post_escalation"]
        }
      }
    } as unknown as Scenario;
    expect(lintScenario(scenario, {}).join("\n")).toContain(
      "cannot be both required and forbidden"
    );
  });

  it("accepts a well-formed conditional requirement", () => {
    expect(lintScenario(escalationRequired, {})).toEqual([]);
  });
});
