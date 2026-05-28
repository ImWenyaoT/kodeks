import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoRootUrl = pathToFileURL(repoRoot);

/** Reads a workspace file as UTF-8 so tests can assert cross-file contracts. */
function readWorkspaceText(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRootUrl), 'utf8');
}

/** Reads and parses package JSON files used by the pnpm workspace contract. */
function readWorkspaceJson<T>(relativePath: string): T {
  return JSON.parse(readWorkspaceText(relativePath)) as T;
}

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
};

describe('pnpm workspace development contract', () => {
  it('keeps root scripts on pnpm workspace commands', () => {
    const rootPackage = readWorkspaceJson<PackageJson>('package.json');
    const workspace = readWorkspaceText('pnpm-workspace.yaml');

    expect(rootPackage.packageManager).toBe('pnpm@10.24.0');
    expect(workspace).toContain('apps/*');
    expect(workspace).toContain('packages/*');
    expect(rootPackage.scripts).toMatchObject({
      dev: 'pnpm --filter @kodeks/web dev',
      start: 'pnpm --filter @kodeks/web start',
      build: 'pnpm --filter @kodeks/web build',
      lint: 'pnpm run lint:style && pnpm -r run lint',
      'lint:style': 'eslint .',
      test: 'pnpm -r run test',
      typecheck: 'pnpm -r run typecheck'
    });
    expect(JSON.stringify(rootPackage)).not.toContain('bun --filter');
  });

  it('lets PORT choose the Next.js dev port instead of hard-coding 3000', () => {
    const webPackage = readWorkspaceJson<PackageJson>('apps/web/package.json');
    const devScript = webPackage.scripts?.dev ?? '';
    const startScript = webPackage.scripts?.start ?? '';

    expect(devScript).toBe('next dev --hostname 127.0.0.1');
    expect(startScript).toBe('next start --hostname 127.0.0.1');
    expect(devScript).not.toContain('--port');
    expect(devScript).not.toContain('3000');
    expect(startScript).not.toContain('--port');
    expect(startScript).not.toContain('3000');
  });

  it('keeps CI and README examples aligned with pnpm and PORT', () => {
    const ci = readWorkspaceText('.github/workflows/ci.yml');
    const englishReadme = readWorkspaceText('README.md');
    const chineseReadme = readWorkspaceText('README.zh-CN.md');
    const combinedDocs = `${ci}\n${englishReadme}\n${chineseReadme}`;

    expect(ci).toContain('pnpm/action-setup@v4');
    expect(ci).toContain('pnpm install --frozen-lockfile');
    expect(ci).toContain('pnpm run typecheck');
    expect(ci).toContain('pnpm run lint');
    expect(ci).toContain('pnpm run test');
    expect(ci).toContain('pnpm run build');
    expect(englishReadme).toContain('PORT=3001 pnpm run dev');
    expect(englishReadme).toContain('APP_URL=http://127.0.0.1:3001');
    expect(chineseReadme).toContain('PORT=3001 pnpm run dev');
    expect(chineseReadme).toContain('APP_URL=http://127.0.0.1:3001');
    expect(combinedDocs).not.toContain('oven-sh/setup-bun');
    expect(combinedDocs).not.toContain('bun install');
    expect(combinedDocs).not.toContain('bun run');
  });

  it('does not restore the old workspace metadata after the pnpm migration', () => {
    expect(existsSync(new URL('pnpm-lock.yaml', repoRootUrl))).toBe(true);
    expect(existsSync(new URL('pnpm-workspace.yaml', repoRootUrl))).toBe(true);
    expect(existsSync(new URL('bun.lock', repoRootUrl))).toBe(false);
  });
});
