# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **data liberation sync engine** that extracts Gmail data via OAuth 2.0 into Supabase and exposes a REST API. Gmail messages are pushed in real time via Pub/Sub webhooks (no polling), normalized to the `Message` shape defined in `CONTRACT.md`, and persisted in Supabase PostgreSQL. The REST API is deployed as Vercel Serverless Functions at `/api/v1`.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 |
| Language | TypeScript — strict mode, `"strict": true` in `tsconfig.json` |
| Gmail integration | `googleapis` npm package — OAuth 2.0 client + Gmail API |
| Database client | `@supabase/supabase-js` v2 |
| Testing | Jest + Supertest + `ts-jest` |
| Deployment | Vercel Serverless Functions |

## Two-session architecture

The build is split across two git branches with non-overlapping ownership:

| Session | Branch | Owns |
|---|---|---|
| Server Logic | `main` | `src/`, `api/`, `tests/` |
| Schema | `schema` | `migrations/`, `types/` |

As of now only `main` exists — the `schema` branch split hasn't happened yet, and `migrations/` currently sits on `main` pending that split.

**Sequencing rule: the schema branch cannot be merged until `npm test` exits 0 on `main`.**

The schema session authors migration SQL and shared TypeScript types in isolation. It does not touch `src/` or `api/`. The server logic session does not apply migrations to any database. See `CONTRACT.md §2` for the full gate definition.

## Key documents

- **`CONTRACT.md`** — acceptance criteria, all endpoint contracts (request/response shapes, typed error codes), the `Message` data model with Gmail API field mappings, and the two-session sequencing rule.
- **`build_sequence.md`** — seven atomic build units in order, each with a one-sentence verify check that must pass before the next unit starts.

Read both files before writing any code.

## Commands

```bash
npm test                              # Jest suite (--runInBand); must exit 0 before the schema branch is merged
npx tsc --noEmit                      # Type-check without emitting; must exit 0 at all times
vercel dev                            # Local preview of all Vercel Functions on port 3000
npx jest --testPathPattern=drafts     # Run a single test file matching "drafts"
npm run build                         # tsc compile to dist/
npm run db:types                      # Regenerate src/types/database.ts from the linked Supabase schema
npm run db:push                       # Push migrations/ to the linked Supabase project
```

`npm run dev` (`ts-node src/index.ts`) is stale — `src/index.ts` doesn't exist. Use `vercel dev` instead.

## Architecture

The project deploys as **Vercel Serverless Functions** (no Express). TypeScript compiles from two source roots (`tsconfig.json` `include`), output to `dist/`.

- **`api/`** — Vercel Function entry points, one file per route (`api/v1/...`, `api/webhook/gmail.ts`, `api/cron/renew-watch.ts`). Meant to be thin handlers that call into `src/` and shape the response.
- **`src/`** — business logic:
  - `types/provider.ts` — the `EmailProvider` abstraction (`OAuthTokens`, `ListMessagesOptions`/`Result`, `SendMessageOptions`, `ProviderError`). Gmail is the only implementation.
  - `providers/gmail/auth.ts` — OAuth flow (`initiateOAuth`, `exchangeCode`, `refreshAccessToken`, `loadOAuth2Client`), AES-256-GCM token encryption (`encrypt`/`decrypt`, ciphertext format `iv_hex:authTag_hex:ciphertext_hex`), the `tokens` event listener that persists silent refreshes, and Gmail watch registration (`setupWatch`).
  - `sync/index.ts` — `runInitialSync`: seeds the 50 most recent INBOX messages for a **new user only**; deliberately never touches `history_id` (that's set by `setupWatch`, and is the correct Pub/Sub checkpoint).
  - `sync/normalize.ts` — Gmail → `Message` mapping: header extraction, base64url body decoding (recursing through `payload.parts`), and `deriveStatus()`.
  - `webhook/gmail.ts` — `processGmailNotification`: verifies the PubSub token, decodes the notification, pages `history.list` from the stored `history_id`, upserts the delta, advances `history_id`.
  - `send/index.ts` — builds the RFC 2822 raw message and sends via `messages.send`.
  - `db/index.ts` — the only module that talks to Supabase directly; typed against `types/database.ts`.
  - `middleware/jwt.ts`, `middleware/error.ts` — JWT verify/sign and the `ProviderError` → HTTP status/error-envelope mapping.
- **`tests/`** — Jest suite (Unit 7 in `build_sequence.md`).

Two places where the code's actual behavior differs from what a comment nearby claims — trust behavior, not the comment, if they disagree with what's below:

- **Webhook response ordering.** `src/webhook/gmail.ts`'s docstring says the entry point must send `200` *before* calling `processGmailNotification`. `api/webhook/gmail.ts` does the opposite on purpose: it `await`s `processGmailNotification` and only responds after, because a Vercel Function is frozen the instant its response flushes, which would kill "respond-first" background work. Match `api/webhook/gmail.ts` (await, then respond) if you touch this path.
- **Draft logic lives in `api/`, not `src/`.** Unlike every other endpoint, `api/v1/drafts.ts` and `api/v1/drafts/[id]/*.ts` build the RFC 2822 message, call the Gmail drafts API, and upsert Supabase directly in the handler — there is no `src/drafts/`. `README.md`'s architecture diagram lists a `src/drafts/` folder that does not exist.

## Coding conventions

- All error responses use the envelope shape from `CONTRACT.md`: `{ error: { code, message, details? } }` — no bare strings, no HTML error pages.
- All list endpoints use cursor-based pagination (Gmail `pageToken` as cursor). No offset pagination.
- All client-facing endpoints use the `/api/v1` base path.
- All endpoints except `GET /api/v1/auth/google/callback` require `Authorization: Bearer <jwt>`.
- The Pub/Sub webhook endpoint lives at **`/webhook/gmail`** — it is not under `/api/v1` and does not require a JWT; it validates the `GOOGLE_PUBSUB_VERIFICATION_TOKEN` instead.
- Draft endpoints live at `/api/v1/drafts` — separate from `/api/v1/messages`. The Gmail drafts API (`drafts.create`, `drafts.update`, `drafts.delete`) is used for all draft operations; never use `messages.send` for drafts.
- The `status` field on every `Message` is derived from `labelIds` at write time using the priority order in `CONTRACT.md §3`. Never accept `status` as a client-supplied value.
- The `draftId` field stores the Gmail `drafts.id` (not the message ID). It is required to call `drafts.update` and `drafts.delete`. It must be cleared (set to `null`) in Supabase when a draft is sent.
- The generic message upsert paths (`db.upsertMessage`, `sync/normalize.ts`'s `upsertMessages`) never write `draft_id` — omitting the column on the `gmail_id`-conflict upsert preserves whatever a draft endpoint already set. Only `api/v1/drafts*.ts` writes or clears `draft_id`.

## Error codes → HTTP status

`src/middleware/error.ts`'s `handleError` is the single place mapping a `ProviderError.code` to a status; any code not in this map falls through to `500 INTERNAL_ERROR`. Add new codes there, not ad hoc in handlers.

| Code | Status |
|---|---|
| `UNAUTHORIZED` | 401 |
| `SCOPE_MISSING` | 403 |
| `USER_NOT_FOUND` | 404 |
| `MESSAGE_NOT_FOUND` | 404 |
| `THREAD_NOT_FOUND` | 404 |
| `ALREADY_IN_STATE` | 409 |
| `INVALID_LIMIT` | 422 |
| `GMAIL_RATE_LIMITED` | 429 |
| `TOKEN_EXCHANGE_FAILED` | 502 |
| `GMAIL_LIST_FAILED` | 502 |
| `GMAIL_SEND_FAILED` | 502 |
| `GMAIL_MODIFY_FAILED` | 502 |
| `GMAIL_UNAVAILABLE` | 503 |

## Never do

- **Never use `any` as a TypeScript type.** Use `unknown` and narrow it, or define the correct interface.
- **Never poll the Gmail API for new messages.** All message ingestion is event-driven via Pub/Sub push webhooks that deliver a `historyId`; the sync layer then calls `history.list` for the delta.
- **Never store OAuth tokens in plain text.** Tokens are stored in Supabase and must never appear in logs, error responses, or unencrypted columns.
- **Never make Gmail API calls manually with raw `fetch` or `axios`.** Always use the `googleapis` OAuth2 client, which handles token refresh automatically.
- **Never write to `src/db/` from the schema session branch.** That folder is owned by `main`.
- **Never merge the schema branch before `npm test` exits 0.**
- **Never hardcode credentials.** Every secret is consumed from environment variables.
- **Never delete a Gmail draft without also deleting the Supabase row.** Both must succeed in the same handler; surface the error if the Supabase delete fails.
- **Never accept `status` or `draftId` as client-supplied fields.** Both are server-derived and server-managed only.

## Gmail API notes

All message reads use `messages.get(id, { format: 'FULL' })`. Headers (`From`, `To`, `Subject`, `Date`) are extracted from `message.payload.headers[]` by name (case-insensitive). Body parts are found by `mimeType` (`text/plain` / `text/html`) in `message.payload.parts[]` and base64url-decoded; for single-part messages fall back to `message.payload.body.data`. `isRead`, `isStarred`, and `status` are derived from `labelIds` at write time — do not store them as independent source fields.

Draft creation uses `drafts.create` (not `messages.send`). The response contains `draft.id` (store as `draftId`) and `draft.message.id` (store as `gmailId`). Draft updates use `drafts.update` with the full message body re-encoded as RFC 2822 raw. Sending a draft uses `drafts.send` — this transitions the row: clear `draftId`, update `gmailId` to the new sent message ID, set `status = 'sent'`.

Required OAuth scopes: `gmail.modify`, `userinfo.email`, `userinfo.profile` — the latter two back the `getTokenInfo` call in `exchangeCode` that supplies `email`/`name` for the user row and JWT. `initiateOAuth` always sets `access_type: 'offline'` + `prompt: 'consent'`; dropping either means Google omits the refresh token and `exchangeCode` fails with `TOKEN_EXCHANGE_FAILED`.

A user's Supabase `users.id` (UUID) — not their Google `sub` — is the JWT `sub` claim and the FK on `messages.user_id`. `persistTokens` upserts users on `google_id`; the webhook instead looks a user up by `email` (from the PubSub `GmailNotification.emailAddress`).

## Supabase

Use `SUPABASE_SERVICE_ROLE_KEY` (not the anon key) for all server-side writes. The migration SQL must not be applied to any database until `npm test` exits 0.

## Environment variables

All required variables are in `.env.example`. The non-obvious ones:

| Variable | Purpose |
|---|---|
| `GOOGLE_PUBSUB_TOPIC` | Full Pub/Sub topic name for Gmail push notifications |
| `GOOGLE_PUBSUB_VERIFICATION_TOKEN` | Shared secret to validate inbound Pub/Sub push payloads |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — bypasses RLS; server-only |
| `ENCRYPTION_KEY` | 64-char hex string (32 bytes) — AES-256-GCM key for encrypting OAuth tokens at rest |
| `FRONTEND_URL` | OAuth callback redirects here after issuing the JWT |
| `CRON_SECRET` | Not in `.env.example`. Vercel auto-injects this and sends it as `Authorization: Bearer <CRON_SECRET>` on cron invocations; `api/cron/renew-watch.ts` skips verification entirely when it's unset (e.g. local dev), so set it in the Vercel dashboard for any real deployment |
