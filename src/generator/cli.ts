import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DocumentError, readDocument } from './document.js';
import { emit } from './emit.js';
import { hasChanges, OutputRefused, plan, write, writeTextAtomically } from './output.js';
import { type Credential, fetchDocument, type Io, readInputFile, SourceError } from './source.js';

export interface CliMeta {
  /** The version of the package, written into the generated files. */
  version: string;
  /** The name the generated code imports its types from. */
  sdkPackage: string;
}

const DEFAULT_TOKEN_ENV = 'ORGANISEYOU_TOKEN';

export const HELP = `organiseyou: typed code for the REST API of one OrganiseYou organization.

Usage:
  organiseyou generate --input <openapi.json> --out <folder> [--check]
  organiseyou generate --url <api address> [--token-env <NAME> | --login] [--save <file>] --out <folder> [--check]

Options:
  --input <file>       A saved openapi.json. The recommended way: save it once with --save, keep it beside your code.
  --url <address>      Fetch <address>/rest/openapi.json. The address is https://<host>/api/<slug>.
  --token-env <NAME>   The environment variable that holds an access token. Default: ${DEFAULT_TOKEN_ENV}.
  --login              Ask for an e-mail address and a password on the terminal (the password is not shown), sign in,
                       fetch the document and sign out. Nothing of it is written anywhere.
  --save <file>        Write the fetched document to a file (it holds no credential). Only with --url.
  --out <folder>       The folder to write into. It must be empty, new, or hold only files this tool wrote.
  --check              Write nothing; exit with 1 when the code in --out is not what a run would write.
  --version            Show the version.
  --help               Show this text.

There is no option for a token or a password: arguments end up in shell history and process lists.
Generate with the login of a person of the same kind as your app's users, so the code has exactly the operations
they may use.`;

type Mode = { input: string } | { url: string; credential: Credential };

interface Options {
  mode: Mode;
  out: string;
  save: string | undefined;
  check: boolean;
}

class UsageError extends Error {
  override readonly name = 'UsageError';
}

function parse(argv: string[]): Options | 'help' | 'version' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        input: { type: 'string' },
        url: { type: 'string' },
        'token-env': { type: 'string' },
        login: { type: 'boolean' },
        save: { type: 'string' },
        out: { type: 'string' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? (error.message.split('\n')[0] ?? 'Bad options.') : 'Bad options.',
    );
  }
  const { values, positionals } = parsed;
  if (values.help === true) return 'help';
  if (values.version === true) return 'version';
  if (positionals.length !== 1 || positionals[0] !== 'generate') {
    throw new UsageError(
      positionals.length === 0
        ? 'Say what to do: organiseyou generate.'
        : `Unknown command: ${positionals.join(' ')}.`,
    );
  }

  const { input, url, save, out } = values;
  if ((input === undefined) === (url === undefined))
    throw new UsageError('Give exactly one of --input and --url.');
  if (out === undefined || out === '') throw new UsageError('--out is required.');
  const check = values.check === true;
  if (save !== undefined && check)
    throw new UsageError('--check writes nothing, so it cannot be used with --save.');

  if (input !== undefined) {
    if (values.login === true || values['token-env'] !== undefined || save !== undefined) {
      throw new UsageError('--login, --token-env and --save go with --url, not --input.');
    }
    return { mode: { input }, out, save: undefined, check };
  }

  if (url === undefined) throw new UsageError('Give exactly one of --input and --url.');
  if (values.login === true && values['token-env'] !== undefined) {
    throw new UsageError('Use --login or --token-env, not both.');
  }
  const name = values['token-env'] ?? DEFAULT_TOKEN_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new UsageError('--token-env must be the name of an environment variable.');
  const credential: Credential = values.login === true ? { kind: 'login' } : { kind: 'env', name };
  return { mode: { url, credential }, out, save, check };
}

/** Runs the command line. Returns the exit code: 0 done, 1 failed or out of date, 2 wrong use. */
export async function runCli(argv: string[], io: Io, meta: CliMeta): Promise<number> {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${HELP}\n`);
    return 2;
  }
  if (options === 'help') {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  if (options === 'version') {
    io.stdout(`${meta.version}\n`);
    return 0;
  }

  const out = resolve(io.cwd, options.out);
  try {
    const text =
      'input' in options.mode
        ? await readInputFile(resolve(io.cwd, options.mode.input))
        : await fetchDocument(options.mode.url, options.mode.credential, io);

    if (options.save !== undefined) {
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        throw new DocumentError('The document is not valid JSON, so it was not saved.');
      }
      await writeTextAtomically(
        resolve(io.cwd, options.save),
        `${JSON.stringify(document, null, 2)}\n`,
      );
      io.stdout(`Saved the document to ${options.save}.\n`);
    }

    const model = readDocument(text);
    for (const warning of model.warnings) io.stderr(`warning: ${warning}\n`);
    const output = emit(model, { version: meta.version, sdkPackage: meta.sdkPackage });

    if (options.check) {
      const changes = await plan(out, output);
      if (!hasChanges(changes)) {
        io.stdout(`The code in ${options.out} is up to date.\n`);
        return 0;
      }
      io.stderr(
        `The code in ${options.out} is out of date. A run would ${[
          ...changes.created.map((name) => `create ${name}`),
          ...changes.updated.map((name) => `change ${name}`),
          ...changes.deleted.map((name) => `delete ${name}`),
        ].join(', ')}.\n`,
      );
      return 1;
    }

    const changes = await write(out, output);
    if (!hasChanges(changes)) {
      io.stdout(`Nothing changed in ${options.out}.\n`);
    } else {
      const parts = [
        changes.created.length > 0 ? `created ${changes.created.length}` : undefined,
        changes.updated.length > 0 ? `changed ${changes.updated.length}` : undefined,
        changes.deleted.length > 0 ? `deleted ${changes.deleted.length}` : undefined,
      ].filter((part) => part !== undefined);
      io.stdout(
        `Wrote ${options.out}: ${parts.join(', ')} files (${model.endpoints.length} endpoints).\n`,
      );
    }
    return 0;
  } catch (error) {
    if (
      error instanceof SourceError ||
      error instanceof DocumentError ||
      error instanceof OutputRefused
    ) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
