/**
 * One percent-encoded path segment. `.` and `..` are refused: a URL parser resolves them (also as `%2e`), so they
 * would leave the segment.
 */
export function encodeSegment(value: string, what: string): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..') {
    throw new TypeError(`${what} must be a non-empty name that is not "." or "..".`);
  }
  return encodeURIComponent(value);
}
