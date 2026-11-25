import type { RequestOptions } from './auth.js';
import { OrganiseYouError } from './error.js';
import { encodeSegment } from './path.js';
import type { SessionEngine } from './session.js';

/** A record as the server sends it: the fields of the endpoint, and its `id`. */
export interface RecordData {
  id: string;
  [field: string]: unknown;
}

/** The values to create or change a record with. */
export type RecordValues = Record<string, unknown>;

/** One page of a list. */
export interface Page<T> {
  items: T[];
  /** How many records the list has in all. */
  total: number;
  page: number;
  perPage: number;
  /** Whether a page follows this one, from `page * perPage < total`. */
  hasNext: boolean;
}

export interface ListOptions extends RequestOptions {
  /** The page to read, from 1. Defaults to 1. */
  page?: number;
  /** The page size. Defaults to the server's, which is 50. */
  perPage?: number;
}

export interface AllOptions extends RequestOptions {
  /** The page size of each request. Defaults to the server's, which is 50. */
  perPage?: number;
}

/** The page size the server uses when a call does not name one. */
const DEFAULT_PER_PAGE = 50;

/** The records of one endpoint, by its name: `oy.records('todos')`. */
export class Records {
  readonly #engine: SessionEngine;
  readonly #name: string;
  readonly #base: string;

  /** Made by `OrganiseYou.records()`; not for apps. */
  constructor(engine: SessionEngine, name: string) {
    this.#engine = engine;
    this.#name = name;
    this.#base = `/rest/${encodeSegment(name, 'The endpoint name')}`;
  }

  /** Reads one page. */
  async list(options: ListOptions = {}): Promise<Page<RecordData>> {
    return (await this.#page(options)).page;
  }

  /**
   * Reads every record, page after page, as the caller asks for them. It stops when it has `total` records, when a
   * page comes back empty, or one page after the last page the latest `total` allows. A list that changes while it
   * is read may skip or repeat a record.
   */
  async *all(options: AllOptions = {}): AsyncGenerator<RecordData, void, undefined> {
    const { perPage, signal } = options;
    let pageSize: number | undefined = perPage;
    let seen = 0;
    for (let number = 1; ; number++) {
      const { page, reportedPerPage } = await this.#page({
        page: number,
        ...(perPage === undefined ? {} : { perPage }),
        ...(signal === undefined ? {} : { signal }),
      });
      seen += page.items.length;
      // Without a page size of its own, the call holds the one the server used for the first page
      pageSize ??= reportedPerPage ?? page.items.length;
      yield* page.items;

      if (page.items.length === 0 || seen >= page.total) return;
      const lastPage = Math.ceil(page.total / Math.max(pageSize, 1));
      if (number >= lastPage + 1) return;
    }
  }

  async get(id: string, options: RequestOptions = {}): Promise<RecordData> {
    const answer = await this.#engine.authorized({
      method: 'GET',
      path: `${this.#base}/record/${encodeSegment(id, 'The record id')}`,
      signal: options.signal,
    });
    return toRecord(answer);
  }

  /** Creates a record. The answer holds the `id` and the values sent, not every field the server sets. */
  async create(values: RecordValues, options: RequestOptions = {}): Promise<RecordData> {
    const answer = await this.#engine.authorized({
      method: 'POST',
      path: `${this.#base}/record`,
      body: toBody(values),
      signal: options.signal,
    });
    return toRecord(answer);
  }

  /** Changes a record: only the keys of `values` are sent, and `null` clears a value. */
  async update(
    id: string,
    values: RecordValues,
    options: RequestOptions = {},
  ): Promise<RecordData> {
    const answer = await this.#engine.authorized({
      method: 'PUT',
      path: `${this.#base}/record/${encodeSegment(id, 'The record id')}`,
      body: toBody(values),
      signal: options.signal,
    });
    return toRecord(answer);
  }

  async delete(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#engine.authorized({
      method: 'DELETE',
      path: `${this.#base}/record/${encodeSegment(id, 'The record id')}`,
      signal: options.signal,
    });
  }

  async #page(options: ListOptions): Promise<{ page: Page<RecordData>; reportedPerPage?: number }> {
    const { page, perPage } = options;
    if (page !== undefined) wholeNumberFrom1(page, 'page');
    if (perPage !== undefined) wholeNumberFrom1(perPage, 'perPage');

    const answer = await this.#engine.authorized({
      method: 'GET',
      path: `${this.#base}/records`,
      query: { page, perPage },
      signal: options.signal,
    });

    if (!isObject(answer) || !Array.isArray(answer['data']) || !isObject(answer['pagination'])) {
      throw notShaped(`The list of ${this.#name} is not in the expected shape.`);
    }
    const pagination = answer['pagination'];
    const total = pagination['total'];
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw notShaped(`The list of ${this.#name} has no total.`);
    }
    // The links of the answer are never followed: the next page is asked for by number, from this base address
    const items = answer['data'].map((item) => toRecord(item));
    const reported = positiveInteger(pagination['perPage']);
    const perPageUsed = reported ?? perPage ?? DEFAULT_PER_PAGE;
    const pageNumber = positiveInteger(pagination['page']) ?? page ?? 1;
    const result: { page: Page<RecordData>; reportedPerPage?: number } = {
      page: {
        items,
        total,
        page: pageNumber,
        perPage: perPageUsed,
        hasNext: pageNumber * perPageUsed < total,
      },
    };
    if (reported !== undefined) result.reportedPerPage = reported;
    return result;
  }
}

function wholeNumberFrom1(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a whole number of 1 or more.`);
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notShaped(message: string): OrganiseYouError {
  return new OrganiseYouError({ kind: 'decoding', message });
}

function toRecord(value: unknown): RecordData {
  if (!isObject(value) || typeof value['id'] !== 'string') {
    throw notShaped('The answer is not a record with an id.');
  }
  return value as RecordData;
}

function toBody(values: RecordValues): RecordValues {
  if (!isObject(values)) throw new TypeError('The values must be an object.');
  return values;
}
