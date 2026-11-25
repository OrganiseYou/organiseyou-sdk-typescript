import { randomBytes } from 'node:crypto';
import { mkdir, open, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATED_PREFIX, MANIFEST_NAME, type Output } from './emit.js';

/** The folder of a run in progress, inside `--out`. A run that was cut short may leave one behind. */
const TEMP_PREFIX = '.organiseyou-tmp-';

/** The output folder cannot be written safely: it holds something that is not generated, or is not a folder. */
export class OutputRefused extends Error {
  override readonly name = 'OutputRefused';
}

export interface Changes {
  /** Files that do not exist yet. */
  created: string[];
  /** Files whose text would change. */
  updated: string[];
  /** Generated files of an earlier run (listed in its manifest) that the output no longer has. */
  deleted: string[];
}

export function hasChanges(changes: Changes): boolean {
  return changes.created.length + changes.updated.length + changes.deleted.length > 0;
}

interface Existing {
  /** Names of the generated files in the folder, without the manifest. */
  generated: Map<string, string>;
  manifest: string | undefined;
  /** The files the old manifest lists. */
  listed: string[];
}

/** First bytes of a file, enough to see the generated line. */
async function firstLine(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0] ?? '';
  } finally {
    await handle.close();
  }
}

/**
 * Looks at the output folder. It refuses when the folder holds anything but generated files, the manifest and the
 * leftovers of a run that was cut short, so hand-written code is never overwritten or deleted.
 */
async function inspect(out: string): Promise<Existing | undefined> {
  let info;
  try {
    info = await lstat(out);
  } catch {
    return undefined;
  }
  if (!info.isDirectory()) throw new OutputRefused('The output path exists and is not a folder.');

  const foreign: string[] = [];
  const generated = new Map<string, string>();
  let manifest: string | undefined;
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (entry.name.startsWith(TEMP_PREFIX) && entry.isDirectory()) continue;
    if (!entry.isFile()) {
      foreign.push(entry.name);
      continue;
    }
    const path = join(out, entry.name);
    if (entry.name === MANIFEST_NAME) {
      manifest = await readFile(path, 'utf8');
      if (parseManifest(manifest) === undefined) foreign.push(entry.name);
    } else if ((await firstLine(path)).startsWith(GENERATED_PREFIX)) {
      generated.set(entry.name, await readFile(path, 'utf8'));
    } else {
      foreign.push(entry.name);
    }
  }
  if (foreign.length > 0) {
    throw new OutputRefused(
      `The output folder holds ${foreign.length === 1 ? 'a file' : 'files'} the generator did not write, so it was left alone: ` +
        `${foreign.sort().join(', ')}. The generator writes only into a folder of its own, or an empty one.`,
    );
  }
  return { generated, manifest, listed: parseManifest(manifest ?? '')?.files ?? [] };
}

/** The files a manifest lists, or `undefined` when the text is not a manifest of this generator. */
function parseManifest(text: string): { files: string[] } | undefined {
  try {
    const parsed = JSON.parse(text) as { generator?: { name?: unknown }; files?: unknown };
    if (parsed.generator?.name !== 'organiseyou' || !Array.isArray(parsed.files)) return undefined;
    const files = parsed.files.filter(
      (f): f is string => typeof f === 'string' && /^[^/\\]+$/.test(f) && f !== '.' && f !== '..',
    );
    return { files };
  } catch {
    return undefined;
  }
}

/** What writing the output would change, and nothing written. Refuses a folder with foreign files. */
export async function plan(out: string, output: Output): Promise<Changes> {
  const existing = await inspect(out);
  const changes: Changes = { created: [], updated: [], deleted: [] };
  for (const [name, text] of output) {
    const current = name === MANIFEST_NAME ? existing?.manifest : existing?.generated.get(name);
    if (current === undefined) changes.created.push(name);
    else if (current !== text) changes.updated.push(name);
  }
  for (const name of existing?.listed ?? []) {
    if (!output.has(name) && existing?.generated.has(name) === true) changes.deleted.push(name);
  }
  changes.deleted.sort();
  return changes;
}

/**
 * Writes the output: the whole of it is built in a folder inside `out` first, then the changed files are moved into
 * place, then the generated files of an earlier run that are gone are deleted. Files that did not change are not
 * touched.
 */
export async function write(out: string, output: Output): Promise<Changes> {
  const changes = await plan(out, output);
  await mkdir(out, { recursive: true });
  const staging = join(out, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`);
  await mkdir(staging);
  try {
    const changed = [...changes.created, ...changes.updated];
    for (const name of changed)
      await writeFile(join(staging, name), output.get(name) ?? '', 'utf8');
    // The manifest goes in last: it only names files that are already there
    for (const name of changed.filter((n) => n !== MANIFEST_NAME))
      await rename(join(staging, name), join(out, name));
    if (changed.includes(MANIFEST_NAME))
      await rename(join(staging, MANIFEST_NAME), join(out, MANIFEST_NAME));
    for (const name of changes.deleted) await rm(join(out, name), { force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  // A folder left by a run that was cut short
  for (const entry of await readdir(out, { withFileTypes: true })) {
    if (entry.name.startsWith(TEMP_PREFIX) && entry.isDirectory()) {
      await rm(join(out, entry.name), { recursive: true, force: true });
    }
  }
  return changes;
}

/** Writes a text file by way of a temporary file, so a failed write leaves no half file. */
export async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
