import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const outputDirectory = resolve("docs/assets");
const startedAt = Date.now();
const events = [];
let transcript = "";

function normalize(text) {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r\n", "\n")
    .replaceAll(root, ".")
    .replaceAll(root.replaceAll("\\", "/"), ".")
    .replaceAll(process.execPath, "node")
    .replaceAll(process.execPath.replaceAll("\\", "/"), "node")
    .replaceAll("\\", "/");
}

function append(text) {
  const clean = normalize(text);
  transcript += clean;
  events.push([(Date.now() - startedAt) / 1000, "o", clean.replaceAll("\n", "\r\n")]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function capture(display, args) {
  append(`$ ${display}\n`);
  let output = "";
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      append(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      append(text);
    });
    child.on("error", rejectPromise);
    child.on("close", resolvePromise);
  });
  append(`Exit code: ${exitCode}\n\n`);
  return { output: normalize(output), exitCode };
}

async function renderGif() {
  const args = [
    "scripts/render-demo-gifs.py",
    "docs/assets/shape-stability.summary.txt",
    "docs/assets/shape-stability.gif",
    "Every run passes, the set does not",
    "identical prompt to divergent shape"
  ];
  append(`$ python ${args.join(" ")}\n`);
  const result = await new Promise((resolvePromise) => {
    const child = spawn("python", args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk) => append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => append(chunk.toString("utf8")));
    child.on("error", (error) => resolvePromise({ exitCode: undefined, error }));
    child.on("close", (exitCode) => resolvePromise({ exitCode }));
  });
  if (result.error) {
    append(`GIF render skipped: ${result.error.message}\n\n`);
    return { rendered: false, reason: result.error.message };
  }
  append(`Exit code: ${result.exitCode}\n\n`);
  return result.exitCode === 0
    ? { rendered: true, reason: "" }
    : { rendered: false, reason: `python render exited ${result.exitCode}` };
}

function countPasses(output) {
  return (output.match(/^PASS /gm) ?? []).length;
}

function divergentPaths(output) {
  const match = output.match(/Unstable across \d+ runs: (\d+) path/);
  return match ? Number(match[1]) : 0;
}

await mkdir(outputDirectory, { recursive: true });
const driftState = resolve(tmpdir(), `agentdoctor-shape-demo-${process.pid}.txt`);
await rm(driftState, { force: true });

try {
  const cli = resolve("dist/src/cli.js");

  const stable = await capture(
    "node dist/src/cli.js test examples/release-safety.yml --repeat 3 -- node examples/release-agent.mjs",
    [cli, "test", "examples/release-safety.yml", "--repeat", "3", "--", process.execPath, "examples/release-agent.mjs"]
  );
  assert(stable.exitCode === 0, `Stable beat exited ${stable.exitCode}; expected 0`);
  assert(countPasses(stable.output) === 3, "Stable beat did not pass three times");
  assert(
    /Stable across 3 runs: (\d+) paths, identical in every run\./.test(stable.output),
    "Stable beat did not report a stable shape"
  );
  const stablePaths = Number(stable.output.match(/Stable across 3 runs: (\d+) paths/)[1]);

  // The drifting agent makes the same calls against the same fixtures and
  // reports the same facts. Only the key names move, so every run is judged
  // correct on its own and the defect is visible only across the set.
  const drifting = await capture(
    "node dist/src/cli.js test examples/release-safety.yml --repeat 3 -- node examples/release-agent.mjs --drift-state <tmp>",
    [
      cli,
      "test",
      "examples/release-safety.yml",
      "--repeat",
      "3",
      "--",
      process.execPath,
      "examples/release-agent.mjs",
      "--drift-state",
      driftState
    ]
  );
  assert(drifting.exitCode === 1, `Drifting beat exited ${drifting.exitCode}; expected 1`);
  assert(
    countPasses(drifting.output) === 3,
    "Drifting beat must pass every individual run; that is the whole point"
  );
  const paths = divergentPaths(drifting.output);
  assert(paths > 0, "Drifting beat did not report divergent paths");

  const summaryLines = [
    "$ agentdoctor test release-safety.yml --repeat 3 -- node release-agent.mjs",
    "PASS release-safety  (x3)",
    `Stable across 3 runs: ${stablePaths} paths, identical in every run.`,
    "Exit code: 0",
    "$ same contract, same fixtures, drifting report shape",
    "PASS release-safety  (x3)   <- every run passes on its own",
    `Unstable across 3 runs: ${paths} paths differ`,
    "  availableSlots  present in run 1",
    "  slots           present in run 2",
    "  availability.slots present in run 3",
    "Exit code: 1",
    "A contract judges one run at a time.",
    "This defect exists only between runs."
  ];

  await writeFile(
    resolve(outputDirectory, "shape-stability.summary.txt"),
    `${summaryLines.join("\n")}\n`,
    "utf8"
  );

  await writeFile(
    resolve(outputDirectory, "shape-stability.media.json"),
    `${JSON.stringify(
      {
        contract: "examples/release-safety.yml",
        agent: "examples/release-agent.mjs",
        beats: [
          {
            name: "stable agent",
            repeat: 3,
            exitCode: stable.exitCode,
            passingRuns: countPasses(stable.output),
            paths: stablePaths,
            divergentPaths: 0
          },
          {
            name: "drifting report shape",
            repeat: 3,
            exitCode: drifting.exitCode,
            passingRuns: countPasses(drifting.output),
            divergentPaths: paths
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const renderResult = await renderGif();

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
  const cast = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join("\n");
  await writeFile(resolve(outputDirectory, "shape-stability.cast"), `${cast}\n`, "utf8");
  await writeFile(
    resolve(outputDirectory, "shape-stability.txt"),
    `${transcript.trimEnd()}\n`,
    "utf8"
  );

  console.log(
    renderResult.rendered
      ? "Recorded shape stability demo and rendered docs/assets/shape-stability.gif"
      : `Recorded shape stability demo; GIF rendering skipped (${renderResult.reason})`
  );
} finally {
  await rm(driftState, { force: true });
}
