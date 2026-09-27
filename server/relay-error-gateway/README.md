# Relay Error Gateway

Node 18+ loopback proxy for the existing art/cart relay. The relay remains the only
owner of task submission and billing. This service never retries POST requests.
Only `/v1/video*`, `/v1/image*` and `/v1/task*` errors are normalized. Other `/v1/`
responses, successful binary responses and SSE are streamed without buffering.
Media JSON bodies must pass bounded inspection before returning to clients.
Video/task JSON and non-2xx errors have a default 1 MiB limit. Successful HTTP
responses on `/v1/images/*` allow 64 MiB to support `b64_json`; configure
`RELAY_GATEWAY_IMAGE_JSON_MAX_BYTES` (or `maxImageResponseBytes` in tests) up to
128 MiB. Both compressed and decoded bodies must fit the corresponding limit.
Oversized, malformed or undecodable JSON returns a safe error, never raw bytes;
POST submission outcomes remain unknown and are never retried.

## Runtime

Deploy this directory and `shared/public-api-error.cjs`,
`shared/public-error-detail.cjs` together, preserving their relative paths.

```sh
export CORVAS_DIAGNOSTICS_KEY="$(openssl rand -hex 32)"
export RELAY_SITE=art # cart on the other host
export RELAY_DIAGNOSTICS_DIR=/var/lib/relay-error-gateway
node server/relay-error-gateway/gateway.cjs
```

The service binds `127.0.0.1:18089`; upstream is fixed to
`http://127.0.0.1:8080`. `RELAY_GATEWAY_PORT` changes the listen port.
Reverse proxy the media routes to this port. The exact `/internal/diagnostics`
path may be exposed over HTTPS only with the mandatory server-side secret check;
optionally restrict its caller IP as an additional layer. All other internal
paths remain unavailable. No Caddy or backend configuration is changed by these files.
`relay-error-gateway.service` and `environment.example` provide an optional
systemd deployment layout under `/opt/corvas-relay-error-gateway`; they are not
installed or started automatically. Keep the real environment file mode 0600.

`createGateway(options)` returns an `http.Server`. Tests may inject `store`,
`upstreamRequest`, `logReader`, request/response limits and timeout. Production
has no configurable remote upstream. `CORVAS_DIAGNOSTICS_KEY` is required and
must be at least 32 characters; use a generated 32-byte random secret.

## Public Errors

Each forwarded request receives a fresh `rh_` plus 32 hexadecimal characters.
This gateway ID is returned as `X-Request-Id`. A valid client `X-Log-Id`
(`fc_` or `rh_` plus 32 lowercase hexadecimal characters) is preserved for the
relay's existing task recovery flow; absent or invalid log IDs use the gateway
ID. The private record associates `requestId` with `relayLogId`, and exact
database lookups use `relayLogId`. Authorization and request bodies pass through
unchanged. Neither correlation ID is accepted as a task ID.

Non-2xx media responses and explicit failures in bounded JSON responses use
`normalizeRelayFailure`. Public responses contain no raw upstream error,
provider identity, route or billing ledger. Submission timeouts remain unknown;
the gateway does not claim that a task was rejected or no money was charged.

`RELAY_ERROR_RULES_FILE` optionally points to an array of exact mappings:

```json
[{"upstreamCode":"REFERENCE_TOO_LARGE","publicCode":"RH_MEDIA_TOO_LARGE"}]
```

Valid file replacements reload on the next error. Rules contain data only and
cannot execute code. Invalid replacements retain the previous valid snapshot.

## Private Diagnostics

```text
GET /internal/diagnostics?requestId=rh_<32 hex>&includeRelayLog=1
GET /internal/diagnostics?requestId=fc_<32 hex>&includeRelayLog=1
X-Corvas-Diagnostics-Key: <server-side shared secret>
```

Missing/incorrect authentication returns 404. Call this only from an authenticated
administrator backend over a private connection. Do not ship this secret or
the returned diagnostics to a normal client. The ID must be `fc_` or `rh_`
followed by exactly 32 lowercase hexadecimal characters. Matching is exact on
the gateway `requestId`, `relayLogId` or `clientRequestId`; task IDs are never
guessed or used as request correlations.

Successful responses keep the compatible `record` field and add `records`
(newest first, at most ten), `matchedCount` and `recordsTruncated`. The
`relayLog` field includes sanitized rows and per-ID lookup states. At most four
different exact log IDs are queried, including the requested client correlation
first; `relayLogLookupTruncated` flags a larger set of associated attempts.
Response evidence is bounded below the CONFIG connector's 1 MiB allowance;
`evidenceTruncated` identifies omitted complete records or rows. Open a specific
gateway ID to inspect an individual attempt when the aggregate is truncated.

A matching database log can be returned even without a gateway record. In that
case `record` is `null`, `records` is empty and `gatewayRecordMissing` is true.
When neither source has evidence, return 404; unavailable readers return 503.
Neither outcome establishes that a request was free or refunded. The private
endpoint never returns evidence belonging to a different log ID.

Private files use directory mode 0700 and file mode 0600 on POSIX. The default
retention is seven days / 10,000 failed requests. Exact correlation indexes
are rebuilt from these same bounded private files on startup and pruned with
the files. The log records model, numeric parameters, resolution, reference
counts, explicit response/task IDs and request/completion timing, never prompts,
keys or original media URLs. Parameter extraction recognizes the existing
root, `request`, `input` and `parameters` protocol envelopes; it does not walk
arbitrary request objects or capture raw bodies. Diagnostic errors are
recursively redacted. Successes are not persisted.

`includeRelayLog=1` invokes `read-relay-log.py` only when `RELAY_SITE` is set to
`art` or `cart`. It uses a bounded, read-only PostgreSQL transaction through
`docker exec` and matches `logs.log_id` exactly, returning at most five rows.
The reader uses the exact supplied correlation and/or the matched records'
associated relay log IDs, including legacy `fc_` IDs. It exposes recorded
user IDs, numeric token IDs (never token values), channel/model identifiers,
request/task IDs, timing, costs, completion/refund fields and billing detail
only to the authenticated administrator. Missing columns remain null and are
never synthesized. `billingState` remains unknown: the gateway does
not infer a refund from zero cost or a missing row. The caller may examine the
actual ledger fields. Docker and Python 3 are needed only for this optional lookup.

When a relay already removes detailed error text, `RELAY_ERROR_CLASSIFY_FROM_LOG=1`
allows classification using the original error from the exact same private
`log_id`. This lookup waits at most 1.5 seconds and only its normalized public
error is returned; raw rows stay in private diagnostics. Missing records,
timeouts and unavailable readers retain the conservative response. Transport
errors and local size rejections never trigger a database lookup. The optional
lookup does not retry generation or infer any billing outcome.

## Verification

```sh
node --test server/relay-error-gateway/gateway.test.cjs
python -m unittest discover -s server/relay-error-gateway -p "test_*.py"
```

These tests use local mocks and do not submit paid generation requests.
