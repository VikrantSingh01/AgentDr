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

  it("loads ordered fixture cases with argument and call-index selectors", async () => {
      const path = await writeScenario(`
schemaVersion: "0.1"
id: fixture-cases
input:
    message: test
fixtures:
    records.lookup:
      $cases:
        - callIndex: 0
          arguments: { id: first }
          result: { value: 1 }
        - arguments: { id: second }
          result:
            $file: second.json
expect: {}
`);
      await writeFile(resolve(path, "..", "second.json"), `{"value":2}`, "utf8");

      await expect(loadScenario(path)).resolves.toMatchObject({
        resolvedFixtures: {
          "records.lookup": {
            cases: [
              { callIndex: 0, arguments: { id: "first" }, result: { value: 1 } },
              { arguments: { id: "second" }, result: { value: 2 } }
            ]
          }
        }
      });
  });

  it("rejects unreachable fixture cases", async () => {
      const path = await writeScenario(`
schemaVersion: "0.1"
id: unreachable-fixture
input:
    message: test
fixtures:
    echo:
      $cases:
        - result: fallback
        - arguments: { value: later }
          result: unreachable
expect: {}
`);

      await expect(loadScenario(path)).rejects.toThrow(
        "Fixture case 1 for echo is unreachable"
      );
  });

  it("rejects structurally duplicate selectors regardless of key order", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: duplicate-fixture
input:
  message: test
fixtures:
  echo:
    $cases:
      - arguments: { project: Apollo, state: open }
        result: first
      - arguments: { state: open, project: Apollo }
        result: duplicate
expect: {}
`);

    await expect(loadScenario(path)).rejects.toThrow(
      "duplicate selectors at cases 0 and 1"
    );
  });

  it("rejects broader fixture cases that shadow later specific cases", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: shadowed-fixture
input:
  message: test
fixtures:
  echo:
    $cases:
      - arguments: { project: Apollo }
        result: broad
      - arguments: { project: Apollo, state: open }
        result: shadowed
expect: {}
`);

    await expect(loadScenario(path)).rejects.toThrow(
      "Fixture case 1 for echo is unreachable because case 0 matches first"
    );
  });

  it("rejects contradictory tool policies", async () => {
      const path = await writeScenario(`
schemaVersion: "0.1"
id: contradictory
input:
    message: test
expect:
    tools:
      required: [echo]
      forbidden: [echo]
`);

      await expect(loadScenario(path)).rejects.toThrow(
        "Tool echo cannot be both required and forbidden"
      );
  });

  it("rejects confirmation policies made unreachable by forbidden enforcement", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: unreachable-confirmation
input:
  message: test
enforcement:
  preDispatch: true
expect:
  tools:
    forbidden: [calendar.create_event]
  confirmation:
    requiredBefore: [calendar.create_event]
    bindArguments: true
`);

    await expect(loadScenario(path)).rejects.toThrow(
      "Confirmation policy is unreachable under pre-dispatch enforcement because every confirmation-protected tool is forbidden"
    );
  });

  it("accepts a partially overlapping confirmation policy", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: partially-overlapping-confirmation
input:
  message: test
enforcement:
  preDispatch: true
expect:
  tools:
    forbidden: [calendar.delete_event]
  confirmation:
    requiredBefore: [calendar.delete_event, calendar.create_event]
`);

    await expect(loadScenario(path)).resolves.toMatchObject({
      scenario: { id: "partially-overlapping-confirmation" }
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

  it("rejects redaction keys that would corrupt safety evidence", async () => {
    const path = await writeScenario(`
schemaVersion: "0.1"
id: unsafe-redaction
input:
  message: test
mcp:
  server:
    command: [node, server.mjs]
  redaction:
    keys: [tool]
expect: {}
`);

    await expect(loadScenario(path)).rejects.toThrow(
      "Invalid redaction key tool"
    );
  });

    it("rejects redaction keys that would corrupt event shapes", async () => {
      const path = await writeScenario(`
  schemaVersion: "0.1"
  id: unsafe-event-redaction
  input:
    message: test
  mcp:
    server:
      command: [node, server.mjs]
    redaction:
      keys: [arguments]
  expect: {}
  `);

      await expect(loadScenario(path)).rejects.toThrow(
        "Invalid redaction key arguments"
      );
    });

    it("rejects redaction keys that would corrupt discovered contracts", async () => {
      for (const key of ["required", "$ref", "items", "version"]) {
        const path = await writeScenario(`
  schemaVersion: "0.1"
  id: unsafe-contract-redaction-${key.replace(/[^a-z]/gi, "")}
  input:
    message: test
  mcp:
    server:
      command: [node, server.mjs]
    redaction:
      keys: ["${key}"]
  expect: {}
  `);

        await expect(loadScenario(path)).rejects.toThrow(
          `Invalid redaction key ${key}`
        );
      }
    });
});