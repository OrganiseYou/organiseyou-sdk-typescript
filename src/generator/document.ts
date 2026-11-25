import { createHash } from 'node:crypto';

/** What the generator needs from an OpenAPI 3.0 document of the REST API of one organization. */
export interface Model {
  /** The endpoints that have at least one record operation, sorted by name. */
  endpoints: EndpointModel[];
  /** The objects the endpoints use, by component name. */
  objects: Map<string, ObjectModel>;
  /** `info.x-organiseyou-revision`, when the document has it. */
  revision: string | number | undefined;
  /** SHA-256 of the document in a canonical form (keys sorted), as hex. */
  sha256: string;
  /** Things that were not understood and were replaced by `JsonValue`, or skipped. */
  warnings: string[];
}

export interface EndpointModel {
  /** The endpoint's name as the API knows it, which may hold spaces or any other character. */
  name: string;
  list: boolean;
  get: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  /** The component names of the schemas, or `undefined` when the document names none. */
  record: string | undefined;
  input: string | undefined;
  updateInput: string | undefined;
}

export interface ObjectModel {
  fields: FieldModel[];
  /** The schema was not a plain object with properties: the type is a map of any JSON values. */
  open: boolean;
}

export interface FieldModel {
  /** The alias: the JSON key. */
  key: string;
  /** The TypeScript type, without `| null`. */
  type: string;
  nullable: boolean;
  required: boolean;
  readOnly: boolean;
}

type Json = Record<string, unknown>;

type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';

const RECORD_PATH = /^\/rest\/([^/]+)\/(records|record|record\/\{[^/{}]+\})$/;
const SCHEMA_REF = /^#\/components\/schemas\/(.+)$/;

/** The error of a document the generator cannot use at all. */
export class DocumentError extends Error {
  override readonly name = 'DocumentError';
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same document as text with every object's keys in order, so only its content changes the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Reads the document text into a `Model`. A document it cannot use at all is a `DocumentError`. */
export function readDocument(text: string): Model {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DocumentError('The document is not valid JSON.');
  }
  if (!isObject(parsed)) throw new DocumentError('The document is not a JSON object.');
  const version = parsed['openapi'];
  if (typeof version !== 'string' || !/^3\.0(\.|$)/.test(version)) {
    throw new DocumentError(
      `The document is not OpenAPI 3.0 (its "openapi" is ${JSON.stringify(version ?? null)}).`,
    );
  }
  const paths = parsed['paths'];
  if (!isObject(paths)) throw new DocumentError('The document has no "paths".');

  const reader = new Reader(parsed);
  const endpoints = reader.readEndpoints(paths);
  if (endpoints.length === 0) {
    throw new DocumentError(
      'The document has no record endpoints (no operation of /rest/<endpoint>/records or /rest/<endpoint>/record). ' +
        'Did you read the document with the right login?',
    );
  }
  const objects = reader.readObjects(endpoints);

  const info = parsed['info'];
  const revision = isObject(info) ? info['x-organiseyou-revision'] : undefined;
  return {
    endpoints,
    objects,
    revision: typeof revision === 'string' || typeof revision === 'number' ? revision : undefined,
    sha256: createHash('sha256').update(canonicalJson(parsed)).digest('hex'),
    warnings: reader.warnings,
  };
}

class Reader {
  readonly warnings: string[] = [];
  readonly #root: Json;

  constructor(root: Json) {
    this.#root = root;
  }

  readEndpoints(paths: Json): EndpointModel[] {
    const endpoints: EndpointModel[] = [];
    const operationsOf = new Map<string, Partial<Record<Operation, Json>>>();

    for (const path of Object.keys(paths).sort()) {
      const item = paths[path];
      const match = RECORD_PATH.exec(path);
      if (!isObject(item)) continue;
      for (const method of ['get', 'post', 'put', 'delete'] as const) {
        const operation = item[method];
        if (!isObject(operation)) continue;
        const declared = operation['x-organiseyou-endpoint'];
        // Without the extension, the tag and the path name the endpoint (a server that predates it)
        if (match === null) {
          if (typeof declared === 'string')
            this.warnings.push(
              `Skipped ${method.toUpperCase()} ${path}: it is not a record operation.`,
            );
          continue;
        }
        const segment = safeDecode(match[1] ?? '');
        const tags = operation['tags'];
        const tag = Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : undefined;
        const name = typeof declared === 'string' ? declared : (tag ?? segment);
        if (name !== segment) {
          this.warnings.push(
            `Skipped ${method.toUpperCase()} ${path}: it names the endpoint ${JSON.stringify(name)}, but the path is ${JSON.stringify(segment)}.`,
          );
          continue;
        }
        const kind = operationOf(method, match[2] ?? '');
        if (kind === undefined) continue;
        const known = operationsOf.get(name) ?? {};
        known[kind] = operation;
        operationsOf.set(name, known);
      }
    }

    for (const name of [...operationsOf.keys()].sort(compare)) {
      const operations = operationsOf.get(name) ?? {};
      endpoints.push({
        name,
        list: operations.list !== undefined,
        get: operations.get !== undefined,
        create: operations.create !== undefined,
        update: operations.update !== undefined,
        delete: operations.delete !== undefined,
        record: this.#recordSchema(operations),
        input: operations.create === undefined ? undefined : this.#requestSchema(operations.create),
        updateInput:
          operations.update === undefined ? undefined : this.#requestSchema(operations.update),
      });
    }
    return endpoints;
  }

  readObjects(endpoints: EndpointModel[]): Map<string, ObjectModel> {
    const wanted = new Set<string>();
    for (const endpoint of endpoints) {
      for (const name of [endpoint.record, endpoint.input, endpoint.updateInput]) {
        if (name !== undefined) wanted.add(name);
      }
    }
    const objects = new Map<string, ObjectModel>();
    for (const name of [...wanted].sort(compare)) objects.set(name, this.#object(name));
    return objects;
  }

  /** The record schema: from get, else create, else update, else the items of the list. */
  #recordSchema(operations: Partial<Record<Operation, Json>>): string | undefined {
    for (const [kind, status] of [
      ['get', '200'],
      ['create', '201'],
      ['update', '200'],
    ] as const) {
      const operation = operations[kind];
      const name =
        operation === undefined
          ? undefined
          : this.#schemaName(this.#responseSchema(operation, status));
      if (name !== undefined) return name;
    }
    if (operations.list !== undefined) {
      const list = this.#schemaOf(this.#responseSchema(operations.list, '200'));
      const data =
        isObject(list) && isObject(list['properties']) ? list['properties']['data'] : undefined;
      const items = isObject(data) ? data['items'] : undefined;
      return this.#schemaName(items);
    }
    return undefined;
  }

  #requestSchema(operation: Json): string | undefined {
    const body = this.#resolve(operation['requestBody']);
    const content = isObject(body) ? body['content'] : undefined;
    const json = isObject(content) ? content['application/json'] : undefined;
    return this.#schemaName(isObject(json) ? json['schema'] : undefined);
  }

  #responseSchema(operation: Json, status: string): unknown {
    const responses = operation['responses'];
    const response = isObject(responses) ? this.#resolve(responses[status]) : undefined;
    const content = isObject(response) ? response['content'] : undefined;
    const json = isObject(content) ? content['application/json'] : undefined;
    return isObject(json) ? json['schema'] : undefined;
  }

  /** The component name a schema refers to. */
  #schemaName(schema: unknown): string | undefined {
    if (!isObject(schema)) return undefined;
    const ref = schema['$ref'];
    if (typeof ref !== 'string') return undefined;
    const name = SCHEMA_REF.exec(ref)?.[1];
    return name !== undefined && this.#component(name) !== undefined ? name : undefined;
  }

  #schemaOf(schema: unknown): unknown {
    const name = this.#schemaName(schema);
    return name === undefined ? schema : this.#component(name);
  }

  #component(name: string): unknown {
    const components = this.#root['components'];
    const schemas = isObject(components) ? components['schemas'] : undefined;
    return isObject(schemas) ? schemas[unescapePointer(name)] : undefined;
  }

  /** Follows a `$ref` to `#/components/...` once. */
  #resolve(value: unknown): unknown {
    if (!isObject(value) || typeof value['$ref'] !== 'string') return value;
    const parts = value['$ref'].split('/');
    if (parts[0] !== '#' || parts[1] !== 'components' || parts.length !== 4) return undefined;
    const group = this.#root['components'];
    const section = isObject(group) ? group[parts[2] ?? ''] : undefined;
    return isObject(section) ? section[unescapePointer(parts[3] ?? '')] : undefined;
  }

  #object(name: string): ObjectModel {
    const schema = this.#component(name);
    if (!isObject(schema) || !isObject(schema['properties'])) {
      this.warnings.push(
        `The schema ${JSON.stringify(name)} is not an object with properties: it is a map of JSON values.`,
      );
      return { fields: [], open: true };
    }
    const required = new Set(
      Array.isArray(schema['required'])
        ? schema['required'].filter((r): r is string => typeof r === 'string')
        : [],
    );
    const fields: FieldModel[] = [];
    for (const key of Object.keys(schema['properties']).sort(compare)) {
      const property = this.#resolve(schema['properties'][key]);
      const where = `${name}.${key}`;
      fields.push({
        key,
        type: this.#type(property, where),
        nullable: isObject(property) && property['nullable'] === true,
        required: required.has(key),
        readOnly: isObject(property) && property['readOnly'] === true,
      });
    }
    return { fields, open: false };
  }

  /** The TypeScript type of a schema. A shape that is not known becomes `JsonValue`, with a warning. */
  #type(schema: unknown, where: string): string {
    if (!isObject(schema)) {
      this.warnings.push(`${where}: no schema; its type is JsonValue.`);
      return 'JsonValue';
    }
    switch (schema['type']) {
      case 'string':
        return 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array': {
        const items = this.#resolve(schema['items']);
        const element = items === undefined ? 'JsonValue' : this.#type(items, `${where}[]`);
        return `${/[|&]/.test(element) ? `(${element})` : element}[]`;
      }
      case undefined:
        // No type at all means any value, which is not a mistake; anything else with no type is
        if (['oneOf', 'anyOf', 'allOf', 'not', '$ref'].some((key) => key in schema)) {
          this.warnings.push(
            `${where}: a schema shape that is not supported; its type is JsonValue.`,
          );
        }
        return 'JsonValue';
      default:
        this.warnings.push(
          `${where}: the type ${JSON.stringify(schema['type'])} is not supported; its type is JsonValue.`,
        );
        return 'JsonValue';
    }
  }
}

function operationOf(
  method: 'get' | 'post' | 'put' | 'delete',
  rest: string,
): Operation | undefined {
  if (rest === 'records') return method === 'get' ? 'list' : undefined;
  if (rest === 'record') return method === 'post' ? 'create' : undefined;
  if (method === 'get') return 'get';
  if (method === 'put') return 'update';
  if (method === 'delete') return 'delete';
  return undefined;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function unescapePointer(name: string): string {
  return name.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Order by UTF-16 code unit, the same everywhere, so the output never depends on a locale. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
