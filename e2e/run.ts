import { parseArgs } from 'node:util';
import { runEndToEnd } from './flow.js';

const HELP = `The end-to-end check of the SDK against a LOCAL OrganiseYou. Run it by hand; CI never does.

Usage: npm run e2e -- --base-url <https://host/api/slug> [--mailpit-url <address>]

  --base-url     The API address of a local organization prepared for this check. It must point at this machine.
  --mailpit-url  The local Mailpit that catches the e-mails. Default: http://localhost:8025. Must be local too.
  --help         Show this text.

It registers two people (the confirmation link is read from Mailpit), signs them in, creates, lists, updates and
deletes a record, signs out, and checks that the second person never sees the first person's record.`;

async function main(): Promise<number> {
  let values: {
    'base-url'?: string | undefined;
    'mailpit-url'?: string | undefined;
    help?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      options: {
        'base-url': { type: 'string' },
        'mailpit-url': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 2;
  }
  if (values.help === true) {
    console.log(HELP);
    return 0;
  }
  const baseUrl = values['base-url'];
  if (baseUrl === undefined || baseUrl === '') {
    console.error('--base-url is required.');
    console.error(HELP);
    return 2;
  }
  try {
    const passed = await runEndToEnd({
      baseUrl,
      mailpitUrl: values['mailpit-url'] ?? 'http://localhost:8025',
      log: (line) => console.log(line),
    });
    return passed ? 0 : 1;
  } catch (error) {
    // A refused address or a missing Mailpit: nothing was sent
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

process.exitCode = await main();
