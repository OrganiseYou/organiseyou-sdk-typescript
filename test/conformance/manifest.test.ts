import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncFrom, verifyFolder } from '../../scripts/conformance.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/conformance.mjs', import.meta.url));
const COPY = fileURLToPath(new URL('../../conformance/', import.meta.url));

/** `node scripts/conformance.mjs check <folder>`, as the CI job runs it. */
async function check(folder: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, 'check', folder]);
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, output: failed.stdout + failed.stderr };
  }
}

describe('the manifest check of the conformance copy (the CI job)', () => {
  let work: string;
  let copy: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'oy-conformance-'));
    copy = join(work, 'conformance');
    await cp(COPY, copy, { recursive: true });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('exits 0 on the copy in this repository', async () => {
    const { code, output } = await check(COPY);
    expect(output).toContain('match the manifest');
    expect(code).toBe(0);
  });

  it('exits non-zero when one byte of one file changes, and names the file', async () => {
    const file = join(copy, 'scenarios', 'login.json');
    const bytes = await readFile(file);
    bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 1;
    await writeFile(file, bytes);

    const { code, output } = await check(copy);
    expect(code).toBe(1);
    expect(output).toContain('scenarios/login.json: differs from the manifest');
  });

  it('exits non-zero for a missing file, an extra file and a changed digest', async () => {
    await rm(join(copy, 'interactions', 'login-ok.json'));
    await writeFile(join(copy, 'scenarios', 'extra.json'), '{}\n');
    const manifestPath = join(copy, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: { path: string; sha256: string }[];
    };
    const first = manifest.files[0];
    if (first === undefined) throw new Error('The manifest lists no file.');
    first.sha256 = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const { code, output } = await check(copy);
    expect(code).toBe(1);
    expect(output).toContain('interactions/login-ok.json: listed in the manifest but missing');
    expect(output).toContain('scenarios/extra.json: in the folder but not in the manifest');
    expect(output).toContain(`${first.path}: differs from the manifest`);
  });

  it('refuses a manifest that lists a path outside the set', async () => {
    const manifestPath = join(copy, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: { path: string; sha256: string }[];
    };
    manifest.files.push({ path: '../outside.json', sha256: '0'.repeat(64) });
    await writeFile(manifestPath, JSON.stringify(manifest));

    const { problems } = await verifyFolder(copy);
    expect(problems.join('\n')).toContain('not inside the set');
  });

  it('fails without a manifest', async () => {
    await rm(join(copy, 'manifest.json'));
    expect((await check(copy)).code).toBe(1);
  });

  describe('the sync script', () => {
    let checkout: string;

    beforeEach(async () => {
      // A stand-in for a checkout of the application: `sdk/conformance` holding a valid set
      checkout = join(work, 'application');
      await mkdir(join(checkout, 'sdk'), { recursive: true });
      await cp(COPY, join(checkout, 'sdk', 'conformance'), { recursive: true });
    });

    it('copies a set that matches its manifest, over the old copy', async () => {
      await rm(copy, { recursive: true });
      await mkdir(copy);
      await writeFile(join(copy, 'old.json'), '{}');

      const result = await syncFrom(checkout, copy);
      expect(result).toMatchObject({ set: 1, previousSet: undefined });
      expect((await verifyFolder(copy)).problems).toEqual([]);
      await expect(readFile(join(copy, 'old.json'))).rejects.toThrow();
    });

    it('knows the set number it replaces', async () => {
      const result = await syncFrom(checkout, copy);
      expect(result.previousSet).toBe(1);
    });

    it('refuses a source that does not match its own manifest, and leaves the copy alone', async () => {
      const edited = join(checkout, 'sdk', 'conformance', 'scenarios', 'login.json');
      await writeFile(edited, `${await readFile(edited, 'utf8')} `);

      await expect(syncFrom(checkout, copy)).rejects.toThrow('does not match its own manifest');
      expect((await verifyFolder(copy)).problems).toEqual([]);
    });
  });
});
