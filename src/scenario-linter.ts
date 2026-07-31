import type {
  ObligationCondition,
  ResolvedFixtures,
  ResultReference,
  Scenario
} from "./types.js";
import { isStructurallyEqual, isSubset } from "./value-match.js";
import {
  collectMatchTreeErrors,
  collectOutcomeReferenceNodes,
  collectReferenceNodes,
  validateOutcomeReference,
  validateReference
} from "./result-reference.js";

/**
 * Recursive so a disjunction cannot smuggle in a branch that states no
 * condition. A branch that always holds turns the whole condition into a
 * tautology, which is the vacuous obligation this linter exists to prevent.
 */
function validateObligationCondition(
  when: ObligationCondition,
  subject: string,
  errors: string[]
): void {
  if (when.$anyOf) {
    if (when.outcomePath !== undefined) {
      errors.push(`${subject} cannot combine $anyOf with outcomePath`);
    }
    if (when.$anyOf.length < 2) {
      errors.push(`${subject} $anyOf must declare at least two alternatives`);
    }
    for (const branch of when.$anyOf) {
      validateObligationCondition(branch, subject, errors);
    }
    return;
  }
  if (when.outcomePath === undefined) {
    errors.push(`${subject} must declare an outcomePath`);
    return;
  }
  const hasEquals = Object.hasOwn(when, "equals");
  if (hasEquals && when.nonEmpty !== undefined) {
    errors.push(`${subject} cannot combine equals with nonEmpty`);
  }
  if (!hasEquals && when.nonEmpty === undefined) {
    errors.push(`${subject} must declare either equals or nonEmpty`);
  }
  if (when.nonEmpty === false) {
    errors.push(`${subject} sets nonEmpty to false, which states no condition`);
  }
}

export function lintScenario(
  scenario: Scenario,
  fixtures: ResolvedFixtures
): string[] {
  const errors: string[] = [];
  const tools = scenario.expect.tools;
  const requiredEntries = tools?.required ?? [];
  const required = new Set(
    requiredEntries.map((entry) => (typeof entry === "string" ? entry : entry.tool))
  );
  const forbidden = new Set(tools?.forbidden ?? []);

  const conditionalTools = new Set<string>();
  for (const entry of requiredEntries) {
    if (typeof entry === "string") {
      if (conditionalTools.has(entry)) {
        errors.push(
          `Tool ${entry} is both unconditionally required and conditionally required, so the condition can never relax the obligation`
        );
      }
      continue;
    }
    if (required.has(entry.tool) && conditionalTools.has(entry.tool)) {
      errors.push(`Conditional requirement for ${entry.tool} is declared more than once`);
    }
    if (requiredEntries.includes(entry.tool)) {
      errors.push(
        `Tool ${entry.tool} is both unconditionally required and conditionally required, so the condition can never relax the obligation`
      );
    }
    conditionalTools.add(entry.tool);

    validateObligationCondition(
      entry.when,
      `Conditional requirement for ${entry.tool}`,
      errors
    );
  }

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

  const budgets = new Map<string, { minCalls?: number; maxCalls?: number }>();
  for (const budget of tools?.budgets ?? []) {
    if (budgets.has(budget.tool)) {
      errors.push(`Call budget for ${budget.tool} is declared more than once`);
      continue;
    }
    budgets.set(budget.tool, budget);

    if (
      budget.minCalls !== undefined &&
      budget.maxCalls !== undefined &&
      budget.minCalls > budget.maxCalls
    ) {
      errors.push(
        `Call budget for ${budget.tool} is impossible: minimum ${budget.minCalls} exceeds maximum ${budget.maxCalls}`
      );
    }
    if (forbidden.has(budget.tool) && (budget.minCalls ?? 0) > 0) {
      errors.push(
        `Forbidden tool ${budget.tool} cannot have a minimum call budget of ${budget.minCalls}`
      );
    }
    if (required.has(budget.tool) && budget.maxCalls === 0) {
      errors.push(
        `Required tool ${budget.tool} cannot have a maximum call budget of 0`
      );
    }
    const orderedCalls = (tools?.order ?? []).filter(
      (tool) => tool === budget.tool
    ).length;
    if (budget.maxCalls !== undefined && orderedCalls > budget.maxCalls) {
      errors.push(
        `Call budget ${budget.maxCalls} for ${budget.tool} cannot satisfy an order that calls it ${orderedCalls} times`
      );
    }
  }

  const totalMinimum = [...budgets.values()].reduce(
    (total, budget) => total + (budget.minCalls ?? 0),
    0
  );
  if (tools?.maxCalls !== undefined && totalMinimum > tools.maxCalls) {
    errors.push(
      `Per-tool minimum call budgets total ${totalMinimum}, which exceeds the run budget ${tools.maxCalls}`
    );
  }

  const precedencePairs = new Set<string>();
  for (const rule of tools?.precedence ?? []) {
    if (rule.before === rule.after) {
      errors.push(
        `Precedence rule for ${rule.before} cannot order a tool against itself`
      );
      continue;
    }
    if (rule.correlate !== undefined) {
      if (rule.scope !== undefined) {
        errors.push(
          `Precedence rule ${rule.before} before ${rule.after} cannot combine correlate with scope; a per-record rule already has exactly one first call per record`
        );
      }
      const seenPaths = new Set<string>();
      for (const path of rule.correlate) {
        if (seenPaths.has(path)) {
          errors.push(
            `Precedence rule ${rule.before} before ${rule.after} lists correlate path ${path} more than once`
          );
        }
        seenPaths.add(path);
      }
    }
    const key = `${rule.before}\u0000${rule.after}\u0000${(rule.correlate ?? []).join(",")}`;
    if (precedencePairs.has(key)) {
      errors.push(
        `Precedence rule ${rule.before} before ${rule.after} is declared more than once`
      );
      continue;
    }
    precedencePairs.add(key);
    if (precedencePairs.has(`${rule.after}\u0000${rule.before}\u0000${(rule.correlate ?? []).join(",")}`)) {
      errors.push(
        `Precedence rules require ${rule.before} before ${rule.after} and ${rule.after} before ${rule.before}, which cannot both hold`
      );
    }
    const beforeIndex =
      rule.scope === "first"
        ? (tools?.order ?? []).indexOf(rule.before)
        : (tools?.order ?? []).lastIndexOf(rule.before);
    const afterIndex = (tools?.order ?? []).indexOf(rule.after);
    if (beforeIndex !== -1 && afterIndex !== -1 && beforeIndex > afterIndex) {
      errors.push(
        `Precedence rule ${rule.before} before ${rule.after} contradicts the declared order`
      );
    }
    // The rule now reports when `before` never happened, so forbidding `before`
    // while requiring it to precede `after` cannot be satisfied by any run.
    if ((tools?.forbidden ?? []).includes(rule.before)) {
      errors.push(
        `Precedence rule requires ${rule.before} before ${rule.after}, but ${rule.before} is forbidden`
      );
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

  const order = tools?.order ?? [];
  for (const argumentExpectation of tools?.arguments ?? []) {
    if (argumentExpectation.callIndex !== undefined) {
      if (forbidden.has(argumentExpectation.tool)) {
        errors.push(
          `Argument expectation for forbidden tool ${argumentExpectation.tool} targets call index ${argumentExpectation.callIndex}, which can never be observed`
        );
      }
      const ceiling = budgets.get(argumentExpectation.tool)?.maxCalls;
      if (ceiling !== undefined && argumentExpectation.callIndex >= ceiling) {
        errors.push(
          `Argument expectation for ${argumentExpectation.tool} targets call index ${argumentExpectation.callIndex}, which a maximum of ${ceiling} calls can never reach`
        );
      }
      if (argumentExpectation.distinct !== undefined) {
        errors.push(
          `Argument expectation for ${argumentExpectation.tool} cannot combine distinct with callIndex, because a single call is trivially unique`
        );
      }
    }
    if (argumentExpectation.distinct !== undefined) {
      if (forbidden.has(argumentExpectation.tool)) {
        errors.push(
          `Uniqueness expectation for forbidden tool ${argumentExpectation.tool} can never be observed`
        );
      }
      const seenPaths = new Set<string>();
      for (const path of argumentExpectation.distinct) {
        if (seenPaths.has(path)) {
          errors.push(
            `Uniqueness expectation for ${argumentExpectation.tool} lists argument ${path} more than once`
          );
        }
        seenPaths.add(path);
      }
      const ceiling = budgets.get(argumentExpectation.tool)?.maxCalls;
      if (ceiling !== undefined && ceiling < 2) {
        errors.push(
          `Uniqueness expectation for ${argumentExpectation.tool} is vacuous because a maximum of ${ceiling} call(s) can never repeat a value`
        );
      }
    }
    for (const treeError of collectMatchTreeErrors(argumentExpectation.match)) {
      errors.push(
        `Argument expectation for ${argumentExpectation.tool} is invalid: ${treeError}`
      );
    }
    for (const node of collectReferenceNodes(argumentExpectation.match)) {
      const shapeErrors = validateReference(node);
      if (shapeErrors.length > 0) {
        for (const shapeError of shapeErrors) {
          errors.push(
            `Argument expectation for ${argumentExpectation.tool} is invalid: ${shapeError}`
          );
        }
        continue;
      }
      const reference = node as ResultReference;
      if (forbidden.has(reference.tool)) {
        errors.push(
          `Argument expectation for ${argumentExpectation.tool} references forbidden tool ${reference.tool}, so it can never resolve`
        );
        continue;
      }
      const referencedCeiling = budgets.get(reference.tool)?.maxCalls;
      if (
        reference.callIndex !== undefined &&
        referencedCeiling !== undefined &&
        reference.callIndex >= referencedCeiling
      ) {
        errors.push(
          `Argument expectation for ${argumentExpectation.tool} references ${reference.tool} call index ${reference.callIndex}, which a maximum of ${referencedCeiling} calls can never reach`
        );
        continue;
      }
      const referencedIndex = order.indexOf(reference.tool);
      const referencingIndex = order.indexOf(argumentExpectation.tool);
      if (
        referencedIndex !== -1 &&
        referencingIndex !== -1 &&
        referencingIndex < referencedIndex
      ) {
        errors.push(
          `Argument expectation for ${argumentExpectation.tool} references ${reference.tool}, which the declared order places later`
        );
      }
    }
  }

  // Correlated expectations in the outcome are as capable of being unresolvable
  // as correlated arguments, so they get the same static checks. Without this a
  // contract can reference a tool it also forbids and only discover at run time
  // that the expectation could never have held.
  for (const treeError of collectMatchTreeErrors(scenario.expect.outcome?.match)) {
    errors.push(`Outcome expectation is invalid: ${treeError}`);
  }
  for (const node of collectReferenceNodes(scenario.expect.outcome?.match)) {
    const shapeErrors = validateReference(node);
    for (const shapeError of shapeErrors) {
      errors.push(`Outcome expectation is invalid: ${shapeError}`);
    }
    if (shapeErrors.length === 0 && forbidden.has((node as ResultReference).tool)) {
      errors.push(
        `Outcome expectation references forbidden tool ${(node as ResultReference).tool}, so it can never resolve`
      );
    }
  }

  // A $fromOutcome reference inside the outcome expectation would compare the
  // final output against itself, which can never fail and therefore states
  // nothing.
  for (const node of collectOutcomeReferenceNodes(scenario.expect.outcome?.match)) {
    errors.push(
      `Outcome expectation uses $fromOutcome (${(node as { $fromOutcome: string }).$fromOutcome}), which would compare the final output against itself`
    );
  }

  for (const argumentExpectation of tools?.arguments ?? []) {
    for (const node of collectOutcomeReferenceNodes(argumentExpectation.match)) {
      for (const shapeError of validateOutcomeReference(node)) {
        errors.push(
          `Argument expectation for ${argumentExpectation.tool} is invalid: ${shapeError}`
        );
      }
    }
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
