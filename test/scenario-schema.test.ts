import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../src/scenario-schema.js";

describe("published scenario schema", () => {
  it("matches the runtime validator schema", async () => {
    const published = JSON.parse(
      await readFile(resolve("schema/scenario-0.1.json"), "utf8")
    ) as unknown;

    expect(published).toEqual(scenarioSchema);
  });
});