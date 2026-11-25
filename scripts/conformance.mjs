#!/usr/bin/env node
// The copy of the shared conformance set in `conformance/`, and the two things done with it:
//
//   node scripts/conformance.mjs check [folder]         check a copy against its manifest (the CI job)
//   node scripts/conformance.mjs sync <checkout> [dir]   copy the set from a checkout of the application
//
// `scripts/sync-conformance <checkout>` runs the second. The set is never edited by hand: a file whose SHA-256 is not the
// manifest's, a file the manifest does not list, or a listed file that is missing is a failure. Node's built-ins only.

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'manifest.json';
const SOURCE_FOLDER = join('sdk', 'conformance');
const here = dirname(fileURLToPath(import.meta.url));
/** The folder this repository keeps its copy in. */
export const DEFAULT_FOLDER = join(here, '..', 'conformance');

/**
 * @typedef {{ set: number, date: string, files: { path: string, sha256: string }[] }} Manifest
 * @typedef {{ manifest: Manifest | undefined, problems: string[] }} Verification
 */

/** @param {string | Uint8Array} bytes */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Every file of a folder, as paths with `/`, relative to it.
 * @param {string} folder
 * @returns {Promise<string[]>}
 */
async function listFiles(folder) {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const full = join(entry.parentPath, entry.name);
    files.push(relative(folder, full).split(sep).join('/'));
  }
  return files.sort();
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a folder against its own manifest. Never throws for a bad folder: the problems come back as text.
 * @param {string} folder
 * @returns {Promise<Verification>}
 */
export async function verifyFolder(folder) {
  /** @type {string[]} */
  const problems = [];
  let raw;
  try {
    raw = await readFile(join(folder, MANIFEST), 'utf8');
  } catch {
    return { manifest: undefined, problems: [`${MANIFEST} is missing or cannot be read.`] };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { manifest: undefined, problems: [`${MANIFEST} is not valid JSON.`] };
  }
  if (
    !isObject(parsed) ||
    typeof parsed['set'] !== 'number' ||
    typeof parsed['date'] !== 'string' ||
    !Array.isArray(parsed['files'])
  ) {
    return {
      manifest: undefined,
      problems: [`${MANIFEST} has no set number, date and file list.`],
    };
  }

  /** @type {Manifest['files']} */
  const files = [];
  for (const entry of parsed['files']) {
    if (
      !isObject(entry) ||
      typeof entry['path'] !== 'string' ||
      typeof entry['sha256'] !== 'string'
    ) {
      problems.push(`${MANIFEST} has a file entry without a path and a sha256.`);
      continue;
    }
    const path = entry['path'];
    const segments = path.split('/');
    if (
      path === '' ||
      isAbsolute(path) ||
      path.includes('\\') ||
      segments.some((s) => s === '' || s === '.' || s === '..')
    ) {
      problems.push(
        `${MANIFEST} lists a path that is not inside the set: ${JSON.stringify(path)}.`,
      );
      continue;
    }
    files.push({ path, sha256: entry['sha256'] });
  }

  const listed = new Set(files.map((file) => file.path));
  if (listed.size !== files.length) problems.push(`${MANIFEST} lists a path twice.`);
  if (listed.has(MANIFEST)) problems.push(`${MANIFEST} lists itself.`);

  for (const file of files) {
    let bytes;
    try {
      bytes = await readFile(join(folder, ...file.path.split('/')));
    } catch {
      problems.push(`${file.path}: listed in the manifest but missing.`);
      continue;
    }
    if (sha256(bytes) !== file.sha256) {
      problems.push(`${file.path}: differs from the manifest (SHA-256 does not match).`);
    }
  }

  for (const path of await listFiles(folder)) {
    if (path !== MANIFEST && !listed.has(path)) {
      problems.push(`${path}: in the folder but not in the manifest.`);
    }
  }

  return {
    manifest: { set: parsed['set'], date: parsed['date'], files },
    problems,
  };
}

/**
 * Replaces the copy in `target` with the set of an application checkout. The source must pass its own manifest first,
 * and the new copy is checked again. Returns what was copied.
 * @param {string} checkout
 * @param {string} target
 * @returns {Promise<{ set: number, date: string, previousSet: number | undefined, files: number }>}
 */
export async function syncFrom(checkout, target) {
  const source = join(resolve(checkout), SOURCE_FOLDER);
  const before = await verifyFolder(source);
  if (before.manifest === undefined || before.problems.length > 0) {
    throw new Error(
      `The set in ${SOURCE_FOLDER} of the checkout does not match its own manifest, so nothing was copied:\n` +
        before.problems.map((problem) => `  ${problem}`).join('\n'),
    );
  }

  const previous = await verifyFolder(target).catch(() => ({ manifest: undefined }));
  const previousSet = previous.manifest?.set;

  // Copy next to the target, check it, then swap, so a failed copy never leaves a half set behind
  const parent = dirname(resolve(target));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(target)}-sync-`));
  try {
    await cp(join(source, MANIFEST), join(staging, MANIFEST));
    for (const file of before.manifest.files) {
      const to = join(staging, ...file.path.split('/'));
      await mkdir(dirname(to), { recursive: true });
      await cp(join(source, ...file.path.split('/')), to);
    }
    const after = await verifyFolder(staging);
    if (after.problems.length > 0) {
      throw new Error(`The copy does not match the manifest:\n${after.problems.join('\n')}`);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    set: before.manifest.set,
    date: before.manifest.date,
    previousSet,
    files: before.manifest.files.length,
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'check') {
    const folder = rest[0] ?? DEFAULT_FOLDER;
    const { manifest, problems } = await verifyFolder(folder);
    if (problems.length > 0) {
      console.error(`The copy in ${folder} does not match its manifest:`);
      for (const problem of problems) console.error(`  ${problem}`);
      return 1;
    }
    console.log(
      `Conformance set ${manifest?.set} (${manifest?.date}): ${manifest?.files.length} files and no others match the manifest.`,
    );
    return 0;
  }
  if (command === 'sync' && rest[0] !== undefined) {
    try {
      const result = await syncFrom(rest[0], rest[1] ?? DEFAULT_FOLDER);
      const was =
        result.previousSet === undefined
          ? 'there was no copy before'
          : result.previousSet === result.set
            ? 'the same set number as before'
            : `it was set ${result.previousSet}`;
      console.log(
        `Copied conformance set ${result.set} (${result.date}), ${result.files} files and the manifest; ${was}.`,
      );
      console.log('Review the diff before you commit it: the copy is never edited by hand.');
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  console.error(
    'Usage:\n' +
      '  node scripts/conformance.mjs check [folder]\n' +
      '  scripts/sync-conformance <path to a checkout of the OrganiseYou application>',
  );
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
