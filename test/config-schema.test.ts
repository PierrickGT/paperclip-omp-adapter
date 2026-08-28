import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getConfigSchema } from "../src/server/config-schema.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Config keys the runtime reads that the agent form must not offer.
 *
 * `paperclipSkillSync` is written by Paperclip when an operator picks skills in
 * the board UI, not typed into the adapter's own fields.
 */
const MANAGED_BY_PAPERCLIP = new Set(["paperclipSkillSync"]);

/** Every `config["…"]` the server modules actually read. */
const keysTheRuntimeReads = (): Set<string> => {
  const serverDir = join(projectRoot, "src", "server");
  const keys = new Set<string>();

  for (const file of readdirSync(serverDir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(serverDir, file), "utf8");
    for (const match of source.matchAll(/config\["([a-zA-Z]+)"\]/g)) {
      const key = match[1];
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
};

const schemaKeys = (): string[] => getConfigSchema().fields.map((field) => field.key);

describe("describing the adapter's settings to the agent form", () => {
  it("offers a field for everything an operator needs to set", () => {
    expect(schemaKeys()).toEqual(
      expect.arrayContaining([
        "command",
        "cwd",
        "model",
        "thinking",
        "sessionDir",
        "instructionsFilePath",
        "promptTemplate",
        "timeoutSec",
        "graceSec",
        "extraArgs",
        "env",
      ]),
    );
  });

  it("labels every field, so the form is readable", () => {
    for (const field of getConfigSchema().fields) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.label).not.toBe(field.key);
    }
  });

  it("explains every field, so an operator knows what it does", () => {
    for (const field of getConfigSchema().fields) {
      expect(field.hint.length).toBeGreaterThan(0);
    }
  });

  it("gives each field a type the form can render", () => {
    const renderable = new Set(["text", "number", "textarea", "select", "keyValue", "stringList"]);

    for (const field of getConfigSchema().fields) {
      expect(renderable).toContain(field.type);
    }
  });

  it("names each field once", () => {
    expect(new Set(schemaKeys()).size).toBe(schemaKeys().length);
  });

  it("offers the thinking levels omp accepts, and no others", () => {
    const thinking = getConfigSchema().fields.find((field) => field.key === "thinking");

    expect(thinking?.options).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "auto",
    ]);
  });
});

describe("keeping the form honest about what the runtime does", () => {
  it("offers nothing the runtime would ignore", () => {
    const read = keysTheRuntimeReads();

    for (const key of schemaKeys()) {
      expect(read).toContain(key);
    }
  });

  it("hides nothing an operator is expected to set", () => {
    const offered = new Set(schemaKeys());

    for (const key of keysTheRuntimeReads()) {
      if (MANAGED_BY_PAPERCLIP.has(key)) continue;
      expect(offered).toContain(key);
    }
  });

  it("finds the runtime's keys at all, so the check above cannot pass vacuously", () => {
    expect(keysTheRuntimeReads().size).toBeGreaterThan(5);
  });
});
