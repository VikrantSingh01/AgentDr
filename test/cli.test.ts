import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { initializeScenario } from "../src/initializer.js";
import { loadScenario } from "../src/scenario-loader.js";
import { VERSION } from "../src/version.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("CLI release surface", () => {
  it("reports the package version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      version: string;
    };

    await expect(runCli(["--version"])).resolves.toBe(0);
    expect(VERSION).toBe(packageDocument.version);
    expect(log).toHaveBeenCalledWith(packageDocument.version);
  });

  it("creates a loadable starter scenario without overwriting", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-init-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "nested", "agentdoctor.yml");

    await expect(initializeScenario(path)).resolves.toBe(path);
    await expect(loadScenario(path)).resolves.toMatchObject({
      scenario: { id: "first-agent-contract" },
      fixtures: { "records.lookup": { found: true } }
    });
    await expect(initializeScenario(path)).rejects.toThrow("Refusing to overwrite");
  });

  it("rejects invalid report JSON", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-report-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "report.json");
    await writeFile(path, `{ "not": "a report" }`, "utf8");

    await expect(runCli(["inspect", path])).rejects.toThrow(
      "Invalid Agent Doctor report"
    );
  });

  it("rejects a repeat count that cannot measure stability", async () => {
    await expect(
      runCli(["test", "examples/release-safety.yml", "--repeat", "1", "--", "node", "x.mjs"])
    ).rejects.toThrow("--repeat requires an integer of at least 2");
  });

  it("reports a stable output shape across repeated runs and keeps the passing exit code", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await expect(
      runCli([
        "test",
        "examples/release-safety.yml",
        "--repeat",
        "2",
        "--",
        process.execPath,
        resolve("examples/release-agent.mjs")
      ])
    ).resolves.toBe(0);
    expect(written.join("")).toContain("Stable across 2 runs");
  });

  // Every run here passes its own contract. The defect only exists between the
  // runs, which is the whole reason this mode had to be added.
  it("fails when the report shape depends on the run even though every run passes", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-repeat-"));
    temporaryDirectories.push(directory);
    const marker = resolve(directory, "runs.txt");
    const agent = resolve(directory, "agent.mjs");
    await writeFile(
      resolve(directory, "scenario.yml"),
      [
        `schemaVersion: "0.1"`,
        `id: shape-repeat`,
        `input:`,
        `  message: run twice`,
        `fixtures: {}`,
        `expect:`,
        `  outcome:`,
        `    status: completed`
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      agent,
      [
        `import { appendFileSync, existsSync, readFileSync } from "node:fs";`,
        `const marker = ${JSON.stringify(marker)};`,
        `const seen = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;`,
        `appendFileSync(marker, "x");`,
        `const output = seen === 0 ? { summary: "s", slots: [] } : { summary: "s", availableSlots: [] };`,
        `console.log(JSON.stringify({ type: "final", status: "completed", output }));`
      ].join("\n"),
      "utf8"
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await expect(
      runCli([
        "test",
        resolve(directory, "scenario.yml"),
        "--repeat",
        "2",
        "--",
        process.execPath,
        agent
      ])
    ).resolves.toBe(1);

    const report = written.join("");
    expect(report).toContain("Unstable across 2 runs");
    expect(report).toContain("slots — present in run(s) 1, absent in run(s) 2");
    expect(report).toContain("availableSlots — present in run(s) 2, absent in run(s) 1");
  });

  it("inspects a real MCP stdio server", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli([
        "mcp",
        "inspect",
        "--",
        process.execPath,
        resolve("examples/mcp-release-server.mjs")
      ])
    ).resolves.toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("project.get_release_status");
  });

  it("writes a reusable MCP tool snapshot", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentdoctor-mcp-cli-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "nested", "tools.json");

    await expect(
      runCli([
        "mcp",
        "snapshot",
        path,
        "--",
        process.execPath,
        resolve("examples/mcp-release-server.mjs")
      ])
    ).resolves.toBe(0);
    const tools = JSON.parse(await readFile(path, "utf8")) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("calendar.create_event");
  });
});