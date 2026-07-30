import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STARTER_SCENARIO = `schemaVersion: "0.1"
id: first-agent-contract
input:
  message: Look up the requested record.
fixtures:
  records.lookup:
    found: true
expect:
  tools:
    required:
      - records.lookup
    maxCalls: 1
  outcome:
    status: completed
performance:
  maxDurationMs: 5000
`;

export async function initializeScenario(path = "agentdoctor.yml"): Promise<string> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, STARTER_SCENARIO, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(`Refusing to overwrite existing scenario: ${target}`);
    }
    throw error;
  }
  return target;
}