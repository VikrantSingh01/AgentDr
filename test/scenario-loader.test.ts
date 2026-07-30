import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario-loader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function writeScenario(content: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-loader-"));
  temporaryDirectories.push(directory);
  const path = resolve(directory, "scenario.yml");
  await writeFile(path, content, "utf8");
  return path;
}

describe("scenario loader", () => {
  it("supports inline string fixtures", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: inline-string
input:
  message: test
fixtures:
  echo: hello
expect: {}
`);

    await expect(loadScenario(path)).resolves.toMatchObject({
      fixtures: { echo: "hello" }
    });
  });

  it("loads explicit file fixture references", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: file-fixture
input:
  message: test
fixtures:
  echo:
    $file: result.json
expect: {}
`);
    await writeFile(resolve(path, "..", "result.json"), `{"value":42}`, "utf8");

    await expect(loadScenario(path)).resolves.toMatchObject({
      fixtures: { echo: { value: 42 } }
    });
  });

  it("rejects malformed argument schemas before agent execution", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: malformed-schema
input:
  message: test
expect:
  tools:
    arguments:
      - tool: echo
        schema:
          type: not-a-json-type
`);

    await expect(loadScenario(path)).rejects.toThrow(
      "Invalid argument schema for echo"
    );
  });

  it("accepts Draft 2020-12 argument schemas", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: schema-2020
input:
  message: test
expect:
  tools:
    arguments:
      - tool: echo
        schema:
          $schema: https://json-schema.org/draft/2020-12/schema
          type: array
          prefixItems:
            - type: string
`);

    await expect(loadScenario(path)).resolves.toMatchObject({
      scenario: { id: "schema-2020" }
    });
  });

  it("rejects malformed outcome schemas before agent execution", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: malformed-outcome-schema
input:
  message: test
expect:
  outcome:
    status: completed
    schema:
      type: not-a-json-type
`);

    await expect(loadScenario(path)).rejects.toThrow("Invalid outcome schema");
  });
});