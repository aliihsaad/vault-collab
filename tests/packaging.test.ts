import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  private?: boolean;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("GitHub npm execution packaging", () => {
  it("exposes installable CLI and MCP bins built by prepare", () => {
    const packageJson = JSON.parse(readText("package.json")) as PackageJson;

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.bin).toMatchObject({
      "vault-collab": "./dist/cli.js",
      "vault-collab-mcp": "./dist/mcp/server.js"
    });
    expect(packageJson.scripts?.prepare).toBe("npm run build");
  });

  it("marks both executable entrypoints with node shebangs", () => {
    expect(readText("src/cli.ts").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(readText("src/mcp/server.ts").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("documents the verified GitHub one-liners before local checkout development", () => {
    const readme = readText("README.md");

    expect(readme).toContain(
      "npm exec --yes --package github:aliihsaad/vault-collab -- vault-collab check --db $db"
    );
    expect(readme).toContain(
      "npm exec --yes --package github:aliihsaad/vault-collab -- vault-collab-mcp --db $db"
    );
    expect(readme.indexOf("## Install For Normal Users")).toBeLessThan(
      readme.indexOf("## Development From A Local Checkout")
    );
  });

  it("packages runtime artifacts without dev-only source and test files", () => {
    const npmignore = readText(".npmignore");
    const ignoredPaths = npmignore.split(/\r?\n/);

    expect(npmignore).toContain("src/");
    expect(npmignore).toContain("tests/");
    expect(npmignore).toContain("docs/");
    expect(ignoredPaths).not.toContain("dist/");
  });
});
