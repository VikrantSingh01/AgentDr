import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";

const file = "README.md";
const text = await readFile(file, "utf8");
const scenarioSchema = JSON.parse(await readFile("schema/scenario-0.1.json", "utf8"));
const validateScenario = new Ajv2020({ allErrors: true, strict: false }).compile(
  scenarioSchema
);
const fences = [...text.matchAll(/^```/gm)].length;
if (fences % 2 !== 0) throw new Error(`Unbalanced fences: ${fences}`);
for (const match of text.matchAll(/```(yaml|json)\n([\s\S]*?)```/g)) {
  if (match[1] === "yaml") {
    const scenario = parse(match[2]);
    if (!validateScenario(scenario)) {
      const errors = (validateScenario.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new Error(`README scenario is invalid: ${errors}`);
    }
  } else {
    JSON.parse(match[2]);
  }
}
const links = [...text.matchAll(/!?\[[^\]]*\]\((?!https?:|#)([^)]+)\)/g)]
  .map((match) => match[1].split("#")[0])
  .filter(Boolean);
for (const link of links) {
  await access(resolve(dirname(file), decodeURIComponent(link)));
}
for (const section of [
  "## Exit codes",
  "## CLI",
  "## Evidence and privacy",
  "## Current boundaries"
]) {
  if (!text.includes(section)) throw new Error(`Missing section: ${section}`);
}
console.log(`README structure valid: fences=${fences} links=${links.length}`);
