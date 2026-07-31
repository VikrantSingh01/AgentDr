import { describe, expect, it } from "vitest";
import { collectOutputInterface, renderOutputInterface } from "../src/output-interface.js";
import type { Scenario } from "../src/types.js";

function scenario(expectations: Scenario["expect"]): Scenario {
  return {
    id: "interface",
    agent: { command: ["node", "agent.js"] },
    fixtures: {},
    expect: expectations
  } as Scenario;
}

describe("output interface", () => {
  it("collects the path a conditional obligation reads", () => {
    const result = collectOutputInterface(
      scenario({
        tools: {
          required: [{ tool: "teams.post", when: { outcomePath: "escalatedBugIds", nonEmpty: true } }]
        }
      })
    );

    expect(result.readPaths).toEqual(["escalatedBugIds"]);
  });

  it("collects the path a call budget correlates against", () => {
    const result = collectOutputInterface(
      scenario({ tools: { budgets: [{ tool: "ado.update", callsMatchOutcome: "routed" }] } })
    );

    expect(result.readPaths).toEqual(["routed"]);
  });

  it("collects nested $fromOutcome references from argument expectations", () => {
    const result = collectOutputInterface(
      scenario({
        tools: {
          arguments: [
            {
              tool: "ecs.advance",
              match: {
                fromRing: { $fromOutcome: "ringAdvance.fromRing" },
                toRing: { $fromOutcome: "ringAdvance.toRing" }
              }
            }
          ]
        }
      })
    );

    expect(result.readPaths).toEqual(["ringAdvance.fromRing", "ringAdvance.toRing"]);
  });

  it("reports paths the schema never requires, which an agent cannot discover", () => {
    const result = collectOutputInterface(
      scenario({
        outcome: {
          status: "completed",
          schema: { type: "object", required: ["routed"] } as never
        },
        tools: {
          required: [
            { tool: "teams.post", when: { outcomePath: "escalatedBugIds", nonEmpty: true } }
          ],
          budgets: [{ tool: "ado.update", callsMatchOutcome: "routed" }]
        }
      })
    );

    expect(result.readPaths).toEqual(["escalatedBugIds", "routed"]);
    expect(result.undeclared).toEqual(["escalatedBugIds"]);
  });

  it("treats a nested path as declared only when every level is required", () => {
    const nested = {
      type: "object",
      required: ["ringAdvance"],
      properties: {
        ringAdvance: { type: "object", required: ["attempted"] }
      }
    };

    const declared = collectOutputInterface(
      scenario({
        outcome: { status: "completed", schema: nested as never },
        tools: {
          arguments: [{ tool: "ecs.advance", match: { a: { $fromOutcome: "ringAdvance.attempted" } } }]
        }
      })
    );
    expect(declared.undeclared).toEqual([]);

    const undeclared = collectOutputInterface(
      scenario({
        outcome: { status: "completed", schema: nested as never },
        tools: {
          arguments: [{ tool: "ecs.advance", match: { a: { $fromOutcome: "ringAdvance.fromRing" } } }]
        }
      })
    );
    expect(undeclared.undeclared).toEqual(["ringAdvance.fromRing"]);
  });

  it("renders a prompt that names the undeclared obligations", () => {
    const text = renderOutputInterface(
      scenario({
        outcome: {
          status: "completed",
          schema: { type: "object", required: ["routed"] } as never
        },
        tools: {
          required: [
            { tool: "teams.post", when: { outcomePath: "escalatedBugIds", nonEmpty: true } }
          ]
        }
      })
    );

    expect(text).toContain("escalatedBugIds");
    expect(text).toContain("would not know to report it");
    expect(text).toContain("Key names are part of the contract");
  });

  it("says so plainly when the contract asserts nothing about the output", () => {
    const text = renderOutputInterface(scenario({ tools: { required: ["ado.query"] } }));
    expect(text).toContain("makes no assertion about the final output");
  });
});
