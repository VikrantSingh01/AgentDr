import type { ResolvedFixtures, Scenario } from "./types.js";
import { isStructurallyEqual, isSubset } from "./value-match.js";

export function lintScenario(
  scenario: Scenario,
  fixtures: ResolvedFixtures
): string[] {
  const errors: string[] = [];
  const tools = scenario.expect.tools;
  const required = new Set(tools?.required ?? []);
  const forbidden = new Set(tools?.forbidden ?? []);

  for (const tool of required) {
    if (forbidden.has(tool)) {
      errors.push(`Tool ${tool} cannot be both required and forbidden`);
    }
  }

  if (
    tools?.maxCalls !== undefined &&
    tools.maxCalls < (tools.required?.length ?? 0)
  ) {
    errors.push(
      `Tool call budget ${tools.maxCalls} cannot satisfy ${tools.required!.length} required tools`
    );
  }

  if (
    tools?.maxCalls !== undefined &&
    tools.order !== undefined &&
    tools.maxCalls < tools.order.length
  ) {
    errors.push(
      `Tool call budget ${tools.maxCalls} cannot satisfy an order of ${tools.order.length} calls`
    );
  }

  for (const tool of tools?.order ?? []) {
    if (forbidden.has(tool)) {
      errors.push(`Forbidden tool ${tool} cannot appear in the required order`);
    }
  }

  if (
    scenario.enforcement?.preDispatch &&
    (tools?.forbidden?.length ?? 0) === 0 &&
    (scenario.expect.confirmation?.requiredBefore.length ?? 0) === 0
  ) {
    errors.push(
      "Pre-dispatch enforcement requires a forbidden-tool or confirmation policy"
    );
  }

  if (
    scenario.expect.confirmation?.bindArguments &&
    scenario.expect.confirmation.requiredBefore.length === 0
  ) {
    errors.push("Argument binding requires at least one confirmation-protected tool");
  }

  const confirmationProtected =
    scenario.expect.confirmation?.requiredBefore ?? [];
  if (
    scenario.enforcement?.preDispatch &&
    confirmationProtected.length > 0 &&
    confirmationProtected.every((tool) => forbidden.has(tool))
  ) {
    errors.push(
      "Confirmation policy is unreachable under pre-dispatch enforcement because every confirmation-protected tool is forbidden"
    );
  }

  for (const [tool, fixture] of Object.entries(fixtures)) {
    fixture.cases.forEach((fixtureCase, index) => {
      const duplicateIndex = fixture.cases
        .slice(0, index)
        .findIndex(
          (earlier) =>
            earlier.callIndex === fixtureCase.callIndex &&
            ((earlier.arguments === undefined &&
              fixtureCase.arguments === undefined) ||
              (earlier.arguments !== undefined &&
                fixtureCase.arguments !== undefined &&
                isStructurallyEqual(earlier.arguments, fixtureCase.arguments)))
        );
      if (duplicateIndex !== -1) {
        errors.push(
          `Fixture ${tool} contains duplicate selectors at cases ${duplicateIndex} and ${index}`
        );
        return;
      }

      const shadowingIndex = fixture.cases
        .slice(0, index)
        .findIndex(
          (earlier) =>
            (earlier.callIndex === undefined ||
              (fixtureCase.callIndex !== undefined &&
                earlier.callIndex === fixtureCase.callIndex)) &&
            (earlier.arguments === undefined ||
              (fixtureCase.arguments !== undefined &&
                isSubset(earlier.arguments, fixtureCase.arguments)))
        );
      if (shadowingIndex !== -1) {
        errors.push(
          `Fixture case ${index} for ${tool} is unreachable because case ${shadowingIndex} matches first`
        );
      }
    });
  }

  return errors;
}
