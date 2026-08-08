import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor, runAgentDoctor } from "../dist/src/index.js";

const examplesDirectory = dirname(fileURLToPath(import.meta.url));
const privateToken = "token-that-must-not-persist";
const records = new Map([
  [
    "R-1",
    {
      id: "R-1",
      label: "Apollo release",
      accessToken: privateToken
    }
  ]
]);

function createRecordsBackend() {
  const redaction = { keys: ["accessToken"] };
  const redact = createRedactor(redaction);
  let started = false;

  return {
    redaction,
    async start(timeoutMs) {
      if (timeoutMs <= 0) throw new Error("No startup time remains");
      started = true;
      return [];
    },

    async call(tool, argumentsValue) {
      if (!started) throw new Error("Records backend was not started");
      const startedAt = Date.now();
      if (tool !== "records.lookup") {
        const result = { error: "unknown_tool", tool };
        return {
          result,
          source: "records-api",
          durationMs: Date.now() - startedAt,
          resultBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
          isError: true
        };
      }

      const result = records.get(argumentsValue.id) ?? { found: false };
      return {
        result,
        evidenceResult: redact(result),
        source: "records-api",
        durationMs: Date.now() - startedAt,
        resultBytes: Buffer.byteLength(JSON.stringify(result), "utf8")
      };
    },

    async close() {
      started = false;
    }
  };
}

const completed = await runAgentDoctor({
  scenarioPath: resolve(examplesDirectory, "custom-backend-contract.yml"),
  command: [
    process.execPath,
    resolve(examplesDirectory, "custom-backend-agent.mjs")
  ],
  toolBackendFactory: createRecordsBackend
});

if (JSON.stringify(completed.report).includes(privateToken)) {
  throw new Error("Custom backend secret reached the persisted report");
}

console.log(`Decision: ${completed.report.decision.status}`);
console.log(`Exit code: ${completed.report.decision.exitCode}`);
console.log(`Evidence: ${completed.reportPath}`);
process.exitCode = completed.report.decision.exitCode;