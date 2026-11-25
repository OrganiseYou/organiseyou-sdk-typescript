# Conformance set: changelog

One entry per set number. The set number is raised, and a line added here, whenever a recorded answer, a scenario or a sample
document changes. An SDK release names the set number it passes.

## Set 1: 2026-11-25

The first set: REST and the organization's sign-in endpoints.

- 42 interactions: 40 recorded from the server (sign-in, refresh, sign-out, registration, password reset, `/rest/me`, lists, one
  record, create, update, delete, and the errors 400, 401, 403, 404, 422 and 429) and 2 written by hand (a proxy's 502 HTML
  page, a 200 whose body is not JSON).
- 35 scenarios.
- 4 sample documents for the generators: `todos-app-user.json`, `todos-owner.json`, `all-types.json`, `awkward-names.json`.
- Server behaviour it pins that is easy to miss: a list answer holds `pagination.page` and `pagination.perPage` and is in the
  order of the record ids; a delete answers `200` with an empty body and a `text/html` content type; a create answers only
  the id, the values sent and `assigned_to`; the `RateLimit-*` headers come on every REST answer that passed the limiter, and not
  on a `403` or an error before it.
