import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  private?: boolean;
  bin?: Record<string, string>;
  dependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
}

describe('the package', () => {
  it('is public, has no runtime dependency, and has the organiseyou command', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as PackageJson;
    expect(pkg.private).toBe(false);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.bin).toEqual({ organiseyou: './dist/cli.js' });
  });
});
