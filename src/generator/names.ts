/** Words that cannot be the name of a type, a class or a constant in TypeScript, and names the generated files use. */
const RESERVED = new Set([
  // Reserved words
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  // Strict-mode and contextual words and the names of the predefined types
  'any',
  'as',
  'async',
  'await',
  'bigint',
  'boolean',
  'implements',
  'interface',
  'let',
  'never',
  'number',
  'object',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'string',
  'symbol',
  'undefined',
  'unknown',
  'yield',
  // Names the generated files declare themselves
  'JsonValue',
  'Api',
  'createApi',
]);

/** A name that can be written as a property key without quotes. */
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A string as a single-quoted TypeScript literal. Every character that could end the literal or the line is escaped. */
export function quote(value: string): string {
  const json = JSON.stringify(value);
  const inner = json
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${inner}'`;
}

/** A property key in an interface: the alias as it is, quoted when it is not a plain name. */
export function propertyKey(alias: string): string {
  return PLAIN_KEY.test(alias) ? alias : quote(alias);
}

/** Letters and digits of a name in Studly caps, with a `_` in front when it would start with a digit. */
export function typeIdentifier(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  let identifier = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  if (identifier === '') identifier = 'Model';
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

/** Hands out each identifier once: a name that is taken, or reserved, gets a number (`Class2`). */
export class NameAllocator {
  readonly #taken = new Set<string>();

  take(wanted: string): string {
    let candidate = RESERVED.has(wanted) ? `${wanted}_` : wanted;
    for (let n = 2; this.#taken.has(candidate); n++) candidate = `${wanted}${n}`;
    this.#taken.add(candidate);
    return candidate;
  }
}
