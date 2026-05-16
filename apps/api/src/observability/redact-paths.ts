/**
 * Pino redact paths for the API logger. These run on every log record
 * that touches a request or response object, so they have to be both
 * exhaustive enough to keep secrets out of logs and narrow enough that
 * a busy logger does not pay a per-record traversal tax.
 *
 * Pino's redact uses fast-redact under the hood: wildcards are limited
 * to one segment, and paths must start at the root of the log object.
 * For request data we redact under `req.body`, `req.query`, and
 * `req.headers`; for responses we redact `res.headers`.
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  // Auth headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',

  // Response set-cookie carries session tokens
  'res.headers["set-cookie"]',

  // Direct body fields that frequently carry secrets
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.idToken',
  'req.body.secret',
  'req.body.clientSecret',
  'req.body.apiKey',
  'req.body.pin',
  'req.body.cvv',
  'req.body.cvc',
  'req.body.cardNumber',

  // One level of nesting for the same names (common when bodies wrap
  // a typed object under `user`, `credentials`, `account`, etc.)
  'req.body.*.password',
  'req.body.*.newPassword',
  'req.body.*.currentPassword',
  'req.body.*.token',
  'req.body.*.refreshToken',
  'req.body.*.accessToken',
  'req.body.*.idToken',
  'req.body.*.secret',
  'req.body.*.apiKey',
  'req.body.*.pin',
  'req.body.*.cvv',
  'req.body.*.cvc',
  'req.body.*.cardNumber',

  // Query strings sometimes carry OAuth callback codes and api keys
  'req.query.code',
  'req.query.token',
  'req.query.apikey',
  'req.query.api_key',
  'req.query.access_token',
  'req.query.id_token',
]);
