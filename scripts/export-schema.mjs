import { writeFile } from "node:fs/promises";
import { scenarioSchema } from "../dist/src/scenario-schema.js";

await writeFile(
  new URL("../schema/scenario-0.1.json", import.meta.url),
  `${JSON.stringify(scenarioSchema, null, 2)}\n`,
  "utf8"
);