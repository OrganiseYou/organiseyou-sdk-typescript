import { describe, expect, it } from 'vitest';
import { evaluate } from './compile.js';
import { NameAllocator, propertyKey, quote, typeIdentifier } from '../../src/generator/names.js';

describe('quote', () => {
  const strings = [
    'plain',
    "it's",
    'say "hi"',
    'back\\slash',
    '\\"',
    "\\'",
    'line\nbreak\r\ttab',
    'a*/b',
    '\u2028\u2029',
    '\u0000\u001f',
    'emoji 😀 and ünïcode',
    '${not a template}',
    '`tick`',
    '',
  ];

  it.each(strings)('writes %j as a literal that reads back as the same string', (value) => {
    const literal = quote(value);
    expect(literal.startsWith("'")).toBe(true);
    // Evaluated as source text, as the compiler reads it
    expect(evaluate(literal)).toBe(value);
    expect(literal).not.toMatch(/[\n\r\u2028\u2029]/);
  });
});

describe('propertyKey', () => {
  it('keeps a plain name and quotes anything else', () => {
    expect(propertyKey('title')).toBe('title');
    expect(propertyKey('assigned_to')).toBe('assigned_to');
    expect(propertyKey('class')).toBe('class');
    expect(propertyKey('due date')).toBe("'due date'");
    expect(propertyKey('due-date')).toBe("'due-date'");
    expect(propertyKey('2nd place')).toBe("'2nd place'");
    expect(propertyKey('')).toBe("''");
    expect(propertyKey("it's")).toBe("'it\\'s'");
  });
});

describe('typeIdentifier and NameAllocator', () => {
  it('makes a name from the letters and digits, and keeps a name that starts with a digit usable', () => {
    expect(typeIdentifier('Todos')).toBe('Todos');
    expect(typeIdentifier('my todos-2')).toBe('MyTodos2');
    expect(typeIdentifier('2024Goals')).toBe('_2024Goals');
    expect(typeIdentifier('!!!')).toBe('Model');
    expect(typeIdentifier('ünï')).toBe('N');
  });

  it('numbers a name that is taken and renames a reserved one', () => {
    const names = new NameAllocator();
    expect(names.take('Todos')).toBe('Todos');
    expect(names.take('Todos')).toBe('Todos2');
    expect(names.take('Todos')).toBe('Todos3');
    expect(names.take('Todos2')).toBe('Todos22');
    expect(names.take('JsonValue')).toBe('JsonValue_');
    expect(names.take('Api')).toBe('Api_');
    expect(names.take('class')).toBe('class_');
  });
});
