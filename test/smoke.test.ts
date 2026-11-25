import { describe, expect, it } from 'vitest';

describe('package entry', () => {
  it('loads as an ES module', async () => {
    const entry: object = await import('../src/index.js');
    expect(Object.keys(entry)).toEqual([]);
  });
});
