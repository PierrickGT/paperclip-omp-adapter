import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Guards the one failure mode unit tests cannot see.
 *
 * Paperclip fetches `dist/ui-parser.js` over HTTP and evaluates it in the
 * browser. A single import, or a stray Node API, is invisible to every test in
 * this suite and fatal the moment a run viewer opens. So these assertions read
 * the built artefact, not the source.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const builtParser = join(projectRoot, "dist", "ui-parser.js");

const readBuiltParser = (): string => readFileSync(builtParser, "utf8");

/**
 * Strips comments before checking for forbidden constructs.
 *
 * Prose about imports is not an import, and the first version of this guard
 * failed on its own docblock. Stripping can only ever remove text, so a real
 * `import` statement still cannot slip past.
 */
const executableCodeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

beforeAll(() => {
  if (!existsSync(builtParser)) {
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: projectRoot, stdio: "pipe" });
  }
}, 120_000);

describe("the parser Paperclip evaluates in a browser", () => {
  it("is actually built", () => {
    expect(existsSync(builtParser)).toBe(true);
  });

  it("pulls in nothing at runtime", () => {
    const built = executableCodeOf(readBuiltParser());

    expect(built).not.toMatch(/\bimport\s/);
    expect(built).not.toMatch(/\brequire\s*\(/);
    expect(built).not.toMatch(/\bexport\s+.*\bfrom\b/);
  });

  it("reaches for nothing Node-only", () => {
    const built = executableCodeOf(readBuiltParser());

    expect(built).not.toContain("node:");
    expect(built).not.toMatch(/\bprocess\./);
    expect(built).not.toMatch(/\b__dirname\b/);
    expect(built).not.toMatch(/\bBuffer\b/);
  });

  it("reaches for nothing that only exists in a page", () => {
    const built = executableCodeOf(readBuiltParser());

    expect(built).not.toMatch(/\bdocument\./);
    expect(built).not.toMatch(/\bwindow\./);
    expect(built).not.toMatch(/\blocalStorage\b/);
    expect(built).not.toMatch(/\bfetch\s*\(/);
  });

  it("still offers the entry point the contract names", () => {
    expect(readBuiltParser()).toContain("createStdoutParser");
  });

  it("does nothing on its own when evaluated", async () => {
    const evaluated: unknown = await import(builtParser);

    expect(evaluated).toHaveProperty("createStdoutParser");
  });
});
