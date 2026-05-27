import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const repoRootUrl = pathToFileURL(repoRoot);
const removedPackageManager = "p" + "npm";

/** Reads a workspace file as UTF-8 so tests can assert cross-file contracts. */
function readWorkspaceText(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRootUrl), "utf8");
}

/** Reads and parses package JSON files used by the Bun workspace contract. */
function readWorkspaceJson<T>(relativePath: string): T {
  return JSON.parse(readWorkspaceText(relativePath)) as T;
}

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
  workspaces?: string[];
};

describe("Bun workspace development contract", () => {
  it("keeps root scripts on Bun workspace commands", () => {
    const rootPackage = readWorkspaceJson<PackageJson>("package.json");

    expect(rootPackage.packageManager).toBe("bun@1.3.14");
    expect(rootPackage.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(rootPackage.scripts).toMatchObject({
      dev: "bun --filter @kodeks/web dev",
      start: "bun --filter @kodeks/web start",
      build: "bun --filter @kodeks/web build",
      lint: "bun --workspaces run lint",
      test: "bun --workspaces run test",
      typecheck: "bun --workspaces run typecheck"
    });
    expect(JSON.stringify(rootPackage)).not.toContain(removedPackageManager);
  });

  it("lets PORT choose the Next.js dev port instead of hard-coding 3000", () => {
    const webPackage = readWorkspaceJson<PackageJson>("apps/web/package.json");
    const devScript = webPackage.scripts?.dev ?? "";
    const startScript = webPackage.scripts?.start ?? "";

    expect(devScript).toBe("bun --bun next dev --hostname 127.0.0.1");
    expect(startScript).toBe("bun --bun next start --hostname 127.0.0.1");
    expect(devScript).not.toContain("--port");
    expect(devScript).not.toContain("3000");
    expect(startScript).not.toContain("--port");
    expect(startScript).not.toContain("3000");
  });

  it("keeps CI and README examples aligned with Bun and PORT", () => {
    const ci = readWorkspaceText(".github/workflows/ci.yml");
    const englishReadme = readWorkspaceText("README.md");
    const chineseReadme = readWorkspaceText("README.zh-CN.md");
    const combinedDocs = `${ci}\n${englishReadme}\n${chineseReadme}`;

    expect(ci).toContain("oven-sh/setup-bun@v2");
    expect(ci).toContain("bun install --frozen-lockfile");
    expect(ci).toContain("bun run typecheck");
    expect(ci).toContain("bun run lint");
    expect(ci).toContain("bun run test");
    expect(ci).toContain("bun run build");
    expect(englishReadme).toContain("PORT=3001 bun run dev");
    expect(englishReadme).toContain("APP_URL=http://127.0.0.1:3001");
    expect(chineseReadme).toContain("PORT=3001 bun run dev");
    expect(chineseReadme).toContain("APP_URL=http://127.0.0.1:3001");
    expect(combinedDocs).not.toContain(removedPackageManager);
  });

  it("does not restore the old workspace metadata after the Bun migration", () => {
    expect(existsSync(new URL("bun.lock", repoRootUrl))).toBe(true);
    expect(existsSync(new URL(`${removedPackageManager}-lock.yaml`, repoRootUrl))).toBe(false);
    expect(existsSync(new URL(`${removedPackageManager}-workspace.yaml`, repoRootUrl))).toBe(false);
  });
});
