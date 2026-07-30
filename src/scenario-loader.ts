import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { scenarioSchema } from "./scenario-schema.js";
import type { Scenario } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateScenario = ajv.compile<Scenario>(scenarioSchema);

function parseDocument(path: string, content: string): unknown {
  if (extname(path).toLowerCase() === ".json") {
    return JSON.parse(content) as unknown;
  }

  return parse(content) as unknown;
}

async function resolveFixtures(
  scenario: Scenario,
  scenarioPath: string
): Promise<Record<string, unknown>> {
  const fixtures: Record<string, unknown> = {};

  for (const [tool, fixture] of Object.entries(scenario.fixtures ?? {})) {
    if (
      typeof fixture !== "object" ||
      fixture === null ||
      !("$file" in fixture) ||
      typeof fixture.$file !== "string"
    ) {
      fixtures[tool] = fixture;
      continue;
    }

    if (Object.keys(fixture).length !== 1) {
      throw new Error(`Fixture reference for ${tool} may only contain $file`);
    }

    const fixturePath = resolve(dirname(scenarioPath), fixture.$file);
    let content: string;
    try {
      content = await readFile(fixturePath, "utf8");
    } catch {
      throw new Error(`Fixture for ${tool} was not found: ${fixturePath}`);
    }
    fixtures[tool] = parseDocument(fixturePath, content);
  }

  return fixtures;
}

export async function loadScenario(path: string): Promise<{
  scenario: Scenario;
  fixtures: Record<string, unknown>;
}> {
  const scenarioPath = resolve(path);
  const document: unknown = parseDocument(
    scenarioPath,
    await readFile(scenarioPath, "utf8")
  );

  if (!validateScenario(document)) {
    const errors = (validateScenario.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid scenario: ${errors}`);
  }

  const scenario = document as Scenario;
  for (const argumentExpectation of scenario.expect.tools?.arguments ?? []) {
    if (!argumentExpectation.schema) continue;
    try {
      ajv.compile(argumentExpectation.schema);
    } catch (error) {
      throw new Error(
        `Invalid argument schema for ${argumentExpectation.tool}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    scenario,
    fixtures: await resolveFixtures(scenario, scenarioPath)
  };
}