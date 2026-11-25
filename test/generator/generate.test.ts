import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileProject, evaluate, expectations, fixture, type Project } from './compile.js';

const sample = (name: string): string =>
  fileURLToPath(new URL(`../../conformance/openapi/${name}.json`, import.meta.url));

// Each project is the generator's output, compiled by the TypeScript compiler with `--strict`. A compile takes seconds.
const SLOW = 60_000;

async function fixturesOf(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(new URL(`./fixtures/${folder}/`, import.meta.url))) {
    files[name.replace(/\.txt$/, '')] = await fixture(folder, name);
  }
  return files;
}

describe('the code generated from todos-app-user.json', () => {
  let project: Project;
  let fixtures: Record<string, string>;

  beforeAll(async () => {
    fixtures = await fixturesOf('todos-app-user');
    project = await compileProject(sample('todos-app-user'), fixtures);
  }, SLOW);
  afterAll(async () => project.cleanup());

  it('compiles with --strict: the generated files and the file that uses them', () => {
    const own = project.diagnostics.filter(
      (d) => d.file.startsWith('organiseyou') || d.file === 'good.ts',
    );
    expect(own).toEqual([]);
  });

  it('makes create return a Promise of the record (checked by the compiler in good.txt)', () => {
    expect(fixtures['good']).toContain(
      'Equal<ReturnType<typeof api.todos.create>, Promise<Todos>> = true',
    );
    expect(project.diagnostics.filter((d) => d.file === 'good.ts')).toEqual([]);
  });

  const bad = [
    'wrong-field-name',
    'create-on-reports',
    'missing-required-field',
    'readonly-field-in-update',
    'wrong-value-type',
    'operations-the-endpoint-does-not-have',
    'assign-to-a-readonly-field',
  ];

  it.each(bad)('does not compile: %s, and the compiler says so on the exact line', (name) => {
    const source = fixtures[name] ?? '';
    const wanted = expectations(source);
    expect(wanted.length).toBeGreaterThan(0);
    const got = project.diagnostics.filter((d) => d.file === `${name}.ts`);
    // Exactly the lines that are marked, with the marked code and words, and no other error in the file
    expect(got.map((d) => `${d.line} TS${d.code}`)).toEqual(
      wanted.map((w) => `${w.line} TS${w.code}`),
    );
    for (const w of wanted) {
      const diagnostic = got.find((d) => d.line === w.line);
      expect(diagnostic?.message, `line ${w.line}`).toContain(w.text);
    }
  });
});

describe.each([
  ['todos-owner', undefined],
  ['awkward-names', 'good'],
  ['all-types', 'good'],
])('the code generated from %s.json', (name, usage) => {
  let project: Project;

  beforeAll(async () => {
    const fixtures = usage === undefined ? {} : { [usage]: await fixture(name, `${usage}.txt`) };
    project = await compileProject(sample(name), fixtures);
  }, SLOW);
  afterAll(async () => project.cleanup());

  it('compiles with --strict, with the file that uses it', () => {
    expect(project.diagnostics).toEqual([]);
  });
});

describe('the code generated from awkward-names.json', () => {
  let models = '';
  let index = '';

  beforeAll(async () => {
    const project = await compileProject(sample('awkward-names'));
    models = project.generated.get('models.ts') ?? '';
    index = project.generated.get('index.ts') ?? '';
    await project.cleanup();
  }, SLOW);

  it('keeps every alias as its JSON key, quoted only when it is not a plain name', () => {
    for (const alias of [
      "'due date'",
      "'due-date'",
      "'2nd place'",
      'class?:',
      'default?:',
      'in?:',
      'delete?:',
      'return?:',
    ]) {
      expect(models).toContain(alias);
    }
  });

  it('names the types and endpoints the way the document does, and numbers a clash', () => {
    expect(models).toContain('export interface _2024Goals {');
    expect(models).toContain('export interface MyTodos {');
    expect(models).toContain('export interface MyTodos2 {');
    expect(index).toContain("readonly '2024 goals': _2024GoalsEndpoint;");
    expect(index).toContain("readonly 'my todos': MyTodos2Endpoint;");
    expect(index).toContain("readonly 'my-todos': MyTodosEndpoint;");
  });
});

describe('the code generated from all-types.json', () => {
  it(
    'maps every column type to its TypeScript type',
    async () => {
      const project = await compileProject(sample('all-types'));
      const models = project.generated.get('models.ts') ?? '';
      await project.cleanup();
      for (const line of [
        'string?: string | null;',
        'integer?: number | null;',
        'decimal?: string | null;',
        'boolean?: boolean | null;',
        'datetime?: string | null;',
        'readonly one_to_many?: string[] | null;',
        'many_to_one?: string | null;',
        'readonly auto_increment?: string | null;',
        'assigned_to?: string[] | null;',
        'date?: string | null;',
        'time?: string | null;',
      ]) {
        expect(models).toContain(`  ${line}`);
      }
    },
    SLOW,
  );
});

describe('the code generated from a document with names that need care', () => {
  let project: Project;

  /** A document of the shape the server writes, for endpoints and components named as given. */
  function document(
    endpoints: { name: string; component?: string; fields?: string[]; operations?: string[] }[],
  ): string {
    const paths: Record<string, unknown> = {};
    const schemas: Record<string, unknown> = {};
    for (const {
      name,
      component,
      fields = ['title'],
      operations = ['list', 'get', 'create', 'update', 'delete'],
    } of endpoints) {
      const ref = (schema: string): { $ref: string } => ({
        $ref: `#/components/schemas/${schema}`,
      });
      const body = (schema: string): unknown => ({
        content: { 'application/json': { schema: ref(schema) } },
      });
      const answer = (schema: string | undefined): unknown => ({
        content: { 'application/json': { schema: schema === undefined ? {} : ref(schema) } },
      });
      const segment = encodeURIComponent(name);
      const base = `/rest/${segment}`;
      const operation = (extra: Record<string, unknown>): Record<string, unknown> => ({
        'x-organiseyou-endpoint': name,
        tags: [name],
        ...extra,
      });
      const record = (): Record<string, unknown> => ({});
      void record;
      if (operations.includes('list'))
        paths[`${base}/records`] = {
          get: operation({
            responses: { '200': answer(component === undefined ? undefined : `${component}List`) },
          }),
        };
      const item: Record<string, unknown> = {};
      if (operations.includes('get'))
        item['get'] = operation({ responses: { '200': answer(component) } });
      if (operations.includes('update'))
        item['put'] = operation({
          requestBody: body(`${component ?? 'X'}Update`),
          responses: { '200': answer(component) },
        });
      if (operations.includes('delete')) item['delete'] = operation({ responses: { '200': {} } });
      if (Object.keys(item).length > 0) paths[`${base}/record/{id}`] = item;
      if (operations.includes('create'))
        paths[`${base}/record`] = {
          post: operation({
            requestBody: body(`${component ?? 'X'}Input`),
            responses: { '201': answer(component) },
          }),
        };
      if (component !== undefined) {
        const properties = (writable: boolean): Record<string, unknown> => {
          const entries: [string, unknown][] = fields.map((f) => [
            f,
            { type: 'string', nullable: true },
          ]);
          if (!writable) entries.push(['id', { type: 'string', readOnly: true }]);
          return Object.fromEntries(entries);
        };
        schemas[component] = { type: 'object', properties: properties(false), required: ['id'] };
        schemas[`${component}Input`] = {
          type: 'object',
          properties: properties(true),
          required: [fields[0]],
        };
        schemas[`${component}Update`] = { type: 'object', properties: properties(true) };
        schemas[`${component}List`] = {
          type: 'object',
          properties: { data: { type: 'array', items: ref(component) } },
        };
      }
    }
    return JSON.stringify({
      openapi: '3.0.3',
      info: { title: 't', version: '1.0.0' },
      paths,
      components: { schemas },
    });
  }

  beforeAll(async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'oy-doc-')), 'awkward.json');
    await writeFile(
      path,
      document([
        // Components named like the generated code's own names, and like globals it uses
        { name: 'json', component: 'JsonValue' },
        { name: 'api', component: 'Api' },
        { name: 'page', component: 'Page', fields: ['items', 'total'] },
        { name: 'promise', component: 'Promise' },
        { name: 'record', component: 'RecordData' },
        { name: 'oy', component: 'OrganiseYou' },
        // Names that would end a string or a comment, and keys that are special to objects
        {
          name: 'it\'s a */ "test"\n\u2028',
          component: 'Odd',
          fields: ['__proto__', 'constructor', "it's", 'a*/b', 'x\ny', 'title'],
        },
        // An endpoint the document gives no schemas for, and one with only delete
        { name: 'bare', operations: ['list', 'get', 'create', 'update'] },
        { name: 'gone', operations: ['delete'] },
      ]),
    );
    project = await compileProject(path);
  }, SLOW);
  afterAll(async () => project.cleanup());

  it('compiles with --strict', () => {
    expect(project.diagnostics).toEqual([]);
  });

  it('gives every name once: a clash is numbered, and the generated names are not taken', () => {
    const models = project.generated.get('models.ts') ?? '';
    for (const name of [
      'JsonValue_',
      'Api_',
      'Page',
      'Promise',
      'RecordData',
      'OrganiseYou',
      'Odd',
    ]) {
      expect(models).toMatch(new RegExp(`export interface ${name}( |\\n)`));
    }
    const index = project.generated.get('index.ts') ?? '';
    expect(index).toContain('export interface Api {');
    expect(index).toContain('export function createApi(');
  });

  it('leaves out the operations an endpoint does not have, and types the ones without a schema loosely', () => {
    const endpoints = project.generated.get('endpoints.ts') ?? '';
    const start = endpoints.indexOf('export class GoneEndpoint');
    const gone = endpoints.slice(start, endpoints.indexOf('\n}\n', start));
    expect(gone).toContain('delete(id: string');
    expect(gone).not.toMatch(/\n {2}(list|get|create|update)\(/);
    expect(endpoints).toContain('create(values: oy.RecordValues');
    expect(endpoints).toContain('Promise<oy.RecordData>');
  });

  it('writes the odd names as literals that read back', () => {
    const endpoints = project.generated.get('endpoints.ts') ?? '';
    const literal = /client\.records\((.*)\);/.exec(
      endpoints.slice(endpoints.indexOf('class OddEndpoint')),
    );
    expect(evaluate(literal?.[1] ?? "''")).toBe('it\'s a */ "test"\n\u2028');
  });
});
