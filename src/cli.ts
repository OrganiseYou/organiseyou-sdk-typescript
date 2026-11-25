#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { runCli } from './generator/cli.js';
import type { Io } from './generator/source.js';

// This file sits one folder below package.json, in `src` and in `dist`.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

/** Asks on the terminal. A secret is read with the echo switched off, so it never shows on the screen. */
async function ask(question: string, secret: boolean): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error(
      '--login asks on the terminal, and there is none. Use --token-env or --input instead.',
    );
  }
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const lines = createInterface({ input: stdin, output: secret ? muted : stderr, terminal: true });
  lines.on('SIGINT', () => {
    lines.close();
    process.exit(130);
  });
  try {
    if (secret) stderr.write(question);
    const answer = await lines.question(secret ? '' : question);
    if (secret) stderr.write('\n');
    return answer;
  } finally {
    lines.close();
  }
}

const io: Io = {
  stdout: (text) => void stdout.write(text),
  stderr: (text) => void stderr.write(text),
  ask: (question) => ask(question, false),
  askSecret: (question) => ask(question, true),
  env: process.env,
  cwd: process.cwd(),
  fetch: (input, init) => fetch(input, init),
};

process.exitCode = await runCli(process.argv.slice(2), io, {
  version: pkg.version,
  sdkPackage: pkg.name,
});
