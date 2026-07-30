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
});