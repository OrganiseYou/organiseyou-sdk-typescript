import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { runCli } from '../../src/generator/cli.js';
import type { Io } from '../../src/generator/source.js';

const SDK_ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
export const FIXTURES = new URL('./fixtures/', import.meta.url);

export interface Diagnostic {
  /** Relative to the project's `src` folder. */
  file: string;
  line: number;
  code: number;
  message: string;
}

/** What a fixture file says the compiler must report, from its `// expect: TS<code> <text>` lines. */
export interface Expected {
  line: number;
  code: number;
  text: string;
}

export function expectations(source: string): Expected[] {
  const found: Expected[] = [];
  for (const [index, text] of source.split('\n').entries()) {
    const match = /\/\/ expect: TS(\d+) (.+)$/.exec(text);
    if (match !== null)
      found.push({ line: index + 1, code: Number(match[1]), text: match[2] ?? '' });
  }
  return found;
}

/** The value of a TypeScript or JavaScript literal, read as source text the way the compiler reads it. */
export function evaluate(literal: string): unknown {
  return runInNewContext(literal);
}

export async function fixture(...path: string[]): Promise<string> {
  return readFile(new URL(path.join('/'), FIXTURES), 'utf8');
}

/** An `Io` with nothing behind it: generating from a file needs no terminal and no network. */
export function plainIo(cwd: string): Io {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    ask: () => Promise.reject(new Error('no terminal')),
    askSecret: () => Promise.reject(new Error('no terminal')),
    env: {},
    cwd,
    fetch: () => Promise.reject(new Error('no network')),
  };
}

export interface Project {
  dir: string;
  /** Every diagnostic of `tsc --strict` over the generated code and the fixture files. */
  diagnostics: Diagnostic[];
  /** The generated files, by name. */
  generated: Map<string, string>;
  cleanup(): Promise<void>;
}

/**
 * Generates the code of a sample document into a temporary project, adds the fixture files beside it (as
 * `src/<name>.ts`, importing `./organiseyou/index.js`), and compiles all of it with `--strict` and the other
 * checks the SDK itself is built with. The SDK is the source in this repository.
 */
export async function compileProject(
  documentPath: string,
  fixtures: Record<string, string> = {},
): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), 'oy-generated-'));
  const src = join(dir, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n');

  const code = await runCli(
    ['generate', '--input', documentPath, '--out', 'src/organiseyou'],
    plainIo(dir),
    { version: '0.0.0', sdkPackage: '@organiseyou/sdk' },
  );
  if (code !== 0) throw new Error(`The generator exited with ${code}.`);

  const out = join(src, 'organiseyou');
  const generated = new Map<string, string>();
  for (const name of await readdir(out))
    generated.set(name, await readFile(join(out, name), 'utf8'));

  const roots = [...generated.keys()]
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(out, name));
  for (const [name, text] of Object.entries(fixtures)) {
    const path = join(src, `${name}.ts`);
    await writeFile(path, text);
    roots.push(path);
  }

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    skipLibCheck: true,
    noEmit: true,
    paths: { '@organiseyou/sdk': [SDK_ENTRY] },
  };
  const program = ts.createProgram({ rootNames: roots, options });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic): Diagnostic => {
    const where =
      diagnostic.file === undefined || diagnostic.start === undefined
        ? undefined
        : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      file: diagnostic.file === undefined ? '(project)' : relative(src, diagnostic.file.fileName),
      line: where === undefined ? 0 : where.line + 1,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    };
  });
  return { dir, diagnostics, generated, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
