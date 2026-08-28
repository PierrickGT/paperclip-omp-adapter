import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Checks the package as Paperclip's plugin loader sees it.
 *
 * The loader resolves an external adapter by its export map against built
 * output, so a manifest that points at a file the build does not emit fails at
 * install time and nowhere earlier.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type PackageManifest = {
  name: string;
  type: string;
  engines?: { node?: string };
  exports: Record<string, unknown>;
  paperclip?: { adapterUiParser?: string };
  files?: string[];
  dependencies?: Record<string, string>;
};

const manifest = (): PackageManifest =>
  JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as PackageManifest;

/** Every relative path the export map points at. */
const exportedPaths = (): string[] => {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") found.push(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(manifest().exports);
  return found;
};

beforeAll(() => {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: projectRoot, stdio: "pipe" });
}, 180_000);

describe("the manifest Paperclip's loader reads", () => {
  it("is named the package operators will install", () => {
    expect(manifest().name).toBe("paperclip-omp-adapter");
  });

  it("declares the two entry points an external adapter ships", () => {
    expect(Object.keys(manifest().exports).sort()).toEqual([".", "./ui-parser"]);
  });

  it("declares the UI parser contract version the host matches on", () => {
    expect(manifest().paperclip?.adapterUiParser).toBe("1.0.0");
  });

  it("ships as ES modules on a Node the host supports", () => {
    expect(manifest().type).toBe("module");
    expect(manifest().engines?.node).toBe(">=20");
  });
});

describe("the files the manifest promises", () => {
  it("points only at files the build actually emits", () => {
    for (const path of exportedPaths()) {
      expect(existsSync(join(projectRoot, path))).toBe(true);
    }
  });

  it("ships types alongside the server entry point", () => {
    expect(existsSync(join(projectRoot, "dist", "server", "index.d.ts"))).toBe(true);
  });

  it("packs the built output and nothing else", () => {
    const packed = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const files = (JSON.parse(packed) as [{ files: { path: string }[] }])[0].files.map(
      (file) => file.path,
    );

    expect(files).toContain("dist/server/index.js");
    expect(files).toContain("dist/ui-parser.js");
    expect(files.filter((path) => path.startsWith("src/"))).toHaveLength(0);
    expect(files.filter((path) => path.startsWith("test/"))).toHaveLength(0);
  }, 120_000);
});

describe("what the package pulls in", () => {
  it("declares only dependencies the source actually imports", () => {
    const declared = Object.keys(manifest().dependencies ?? {});
    const sources = execFileSync("git", ["ls-files", "src"], { cwd: projectRoot, encoding: "utf8" })
      .split("\n")
      .filter((path) => path.endsWith(".ts"))
      .map((path) => readFileSync(join(projectRoot, path), "utf8"))
      .join("\n");

    for (const dependency of declared) {
      expect(sources).toContain(dependency);
    }
  });
});

describe("what the README tells an operator", () => {
  it("says plainly that this is not an official adapter", () => {
    const readme = readFileSync(join(projectRoot, "README.md"), "utf8");

    expect(readme).toContain("Community package");
    expect(readme).toContain("@paperclipai/*");
  });
});
