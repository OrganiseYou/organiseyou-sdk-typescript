import { readdirSync, readFileSync } from 'node:fs';

/** The copy of the shared conformance set, and what is in its files (see `conformance/README.md`). */
export const SET_FOLDER = new URL('../../conformance/', import.meta.url);

export interface Interaction {
  id: string;
  description: string;
  synthetic: boolean;
  request: {
    method: string;
    /** Relative to the API base address, with every segment percent-encoded as sent. */
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
    bodyText?: string;
  };
}

export interface SessionStart {
  session: 'none' | 'stored';
  accessToken?: string;
  accessTokenEndsAt?: string;
  refreshToken?: string;
  scope?: string;
  user?: { id: string; name: string; email: string };
}

export interface Expectation {
  result?: unknown;
  error?: {
    kind?: string;
    status?: number;
    code?: string;
    fieldErrors?: Record<string, string[]>;
    retryAfterSeconds?: number;
  };
  state?: { status?: string; reason?: string; user?: { id?: string } };
  lastRateLimit?: { limit?: number; remaining?: number; reset?: number };
}

export interface Step {
  do: string;
  args?: Record<string, unknown>;
  calls?: string[];
  steps?: Step[];
  expect?: Expectation;
}

export interface Scenario {
  id: string;
  description: string;
  now: string;
  start: SessionStart;
  steps: Step[];
  serves: Record<string, number>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, SET_FOLDER), 'utf8')) as T;
}

function names(folder: string): string[] {
  return readdirSync(new URL(folder, SET_FOLDER))
    .filter((name) => name.endsWith('.json'))
    .sort();
}

export function scenarioFiles(): string[] {
  return names('scenarios/');
}

export function interactionFiles(): string[] {
  return names('interactions/');
}

export function loadScenario(file: string): Scenario {
  return readJson<Scenario>(`scenarios/${file}`);
}

export function loadInteraction(file: string): Interaction {
  return readJson<Interaction>(`interactions/${file}`);
}

/** Every interaction of the set, by id. The id is the file name without `.json`, and the file says so too. */
export function loadInteractions(): Map<string, Interaction> {
  const all = new Map<string, Interaction>();
  for (const file of interactionFiles()) {
    const interaction = loadInteraction(file);
    if (interaction.id !== file.replace(/\.json$/, '')) {
      throw new Error(`${file} holds the id ${interaction.id}.`);
    }
    all.set(interaction.id, interaction);
  }
  return all;
}
