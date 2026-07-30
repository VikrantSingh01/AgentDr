import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const startedAt = Date.now();
const events = [];
let transcript = "";
const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const workspacePaths = [process.cwd(), process.cwd().replaceAll("\\", "/")];

function append(text) {
  let clean = text.replace(ansiPattern, "");
  for (const workspacePath of workspacePaths) {
    clean = clean.replaceAll(workspacePath, ".");
  }
  transcript += clean.replaceAll("\r\n", "\n");
  events.push([
    (Date.now() - startedAt) / 1000,
    "o",
    clean.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
  ]);
}

async function run(display, command, args) {
  append(`$ ${display}\n`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => append(chunk.toString("utf8")));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${display} exited with code ${code}`));
    });
  });
  append("\n");
}

await run("node dist/src/cli.js test examples/mcp-release-contract.yml", process.execPath, [
  resolve("dist/src/cli.js"),
  "test",
  "examples/mcp-release-contract.yml"
]);
await run("node node_modules/vitest/vitest.mjs run test/mcp-e2e.test.ts --reporter=verbose", process.execPath, [
  resolve("node_modules/vitest/vitest.mjs"),
  "run",
  "test/mcp-e2e.test.ts",
  "--reporter=verbose"
]);

const directory = resolve("docs");
await mkdir(directory, { recursive: true });
const header = {
  version: 2,
  width: 120,
  height: 36,
  timestamp: Math.floor(startedAt / 1000),
  env: {
    SHELL:
      process.env.SHELL ??
      process.env.ComSpec ??
      (process.platform === "win32" ? "powershell" : "sh"),
    TERM: process.env.TERM ?? "xterm-256color"
  }
};
const cast = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join(
  "\n"
);
await writeFile(resolve(directory, "mcp-demo.cast"), `${cast}\n`, "utf8");
await writeFile(resolve(directory, "mcp-demo.txt"), `${transcript.trimEnd()}\n`, "utf8");
console.log("Recorded docs/mcp-demo.cast and docs/mcp-demo.txt");