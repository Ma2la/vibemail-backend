-- VibeMail — Initial Schema
-- Idempotent: safe to run multiple times on the same database (AC-9).
-- DO NOT apply until npm test exits 0 on main (CONTRACT.md §2).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. users
-- ─────────────────────────────────────────────────────────────────────────────
-- OAuth tokens (encrypted_access_token, encrypted_refresh_token) are stored as
-- AES-256-GCM ciphertext produced by the application layer (src/providers/gmail/auth.ts).
-- The columns are opaque TEXT; no plaintext credential ever reaches the database.
-- Nullable because a row can exist momentarily before persistTokens() runs and
-- to tolerate a future provider that skips token persistence.
--
-- token_expires_at / watch_expiry are Unix-ms timestamps (BIGINT), not
-- TIMESTAMPTZ, because they are round-tripped as raw numbers to/from the
-- googleapis client (`expiry_date`) and compared numerically in src/cron/renewWatch.ts.

CREATE TABLE IF NOT EXISTS public.users (
  id                      UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id               TEXT   UNIQUE NOT NULL,   -- Google OAuth sub; upsert conflict target
  email                   TEXT   UNIQUE NOT NULL,   -- looked up by webhook receiver; must be unique
  name                    TEXT,                     -- Google profile name; not always returned
  -- App-layer encrypted (AES-256-GCM in src/); never plaintext in this column
  encrypted_access_token  TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at        BIGINT,                    -- Unix ms (googleapis expiry_date)
  -- Gmail Pub/Sub watch metadata (Unit 4 — webhook receiver)
  history_id              TEXT,                      -- last known historyId for history.list delta
  watch_expiry            BIGINT,                    -- Unix ms; when the Gmail push watch expires (~7 days)
  watch_resource_id       TEXT,                      -- resourceId returned by watch(); used to stop/renew
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. messages
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per Gmail message per user. `id` is set to gmailId at insert so the
-- primary key doubles as the Gmail message ID.
--
-- Column name mapping (CONTRACT.md TypeScript ↔ SQL):
--   from      → from_address   (reserved word)
--   to        → to_address     (reserved word)
--   userId    → user_id
--   gmailId   → gmail_id
--   threadId  → thread_id
--   labelIds  → label_ids
--   bodyPlain → body_plain
--   bodyHtml  → body_html
--   isRead    → is_read
--   isStarred → is_starred
--   createdAt → created_at
--   updatedAt → updated_at

CREATE TABLE IF NOT EXISTS public.messages (
  id           TEXT        PRIMARY KEY,            -- set to gmailId at insert
  user_id      UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(), -- maintained by trigger below
  -- Gmail message root fields
  gmail_id     TEXT        NOT NULL,
  thread_id    TEXT        NOT NULL,
  label_ids    TEXT[]      NOT NULL DEFAULT '{}',  -- e.g. {"INBOX","UNREAD","STARRED"}
  -- Headers
  from_address TEXT        NOT NULL,               -- header name = "From"
  to_address   TEXT        NOT NULL,               -- header name = "To"
  subject      TEXT        NOT NULL DEFAULT '',    -- header name = "Subject"
  date         TEXT        NOT NULL,               -- header name = "Date" (RFC 2822)
  -- Content
  snippet      TEXT        NOT NULL DEFAULT '',    -- message.snippet (≤100 chars)
  body_plain   TEXT,                               -- text/plain part, base64url-decoded
  body_html    TEXT,                               -- text/html part, base64url-decoded
  -- Derived flags (computed from label_ids at write time)
  is_read      BOOLEAN     NOT NULL DEFAULT false, -- rule: NOT label_ids @> '{"UNREAD"}'
  is_starred   BOOLEAN     NOT NULL DEFAULT false  -- rule: label_ids @> '{"STARRED"}'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE makes functions idempotent.
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER is the idempotent pattern for
-- triggers (CREATE OR REPLACE TRIGGER requires PG 14+; DROP+CREATE is safe
-- on all supported Supabase Postgres versions).

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_updated_at ON public.users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_messages_updated_at ON public.messages;
CREATE TRIGGER trg_messages_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- `id` has no column DEFAULT because its default value (gmailId) lives in
-- another column of the same row. Every insert path (src/db/index.ts,
-- src/sync/normalize.ts, api/v1/drafts.ts, tests/helpers/supabase.ts) omits
-- `id` entirely and relies on the database to fill it in — this trigger is
-- that fill-in. BEFORE INSERT row triggers run before Postgres evaluates
-- ON CONFLICT targets, so this also runs ahead of the gmail_id conflict
-- check below.
CREATE OR REPLACE FUNCTION public.set_message_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := NEW.gmail_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_set_id ON public.messages;
CREATE TRIGGER trg_messages_set_id
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_id();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Required for upsertMessage/upsertMessages' `.upsert(row, { onConflict: 'gmail_id' })`
-- (src/db/index.ts, src/sync/normalize.ts, api/v1/drafts.ts) — Postgres requires
-- a unique index backing an ON CONFLICT target. gmail_id (not id) is the target
-- because gmail_id can change across a draft's update/send lifecycle while id
-- (set once at insert by trg_messages_set_id) stays stable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_gmail_id_unique
  ON public.messages (gmail_id);

-- Filter messages by user
CREATE INDEX IF NOT EXISTS idx_messages_user_id
  ON public.messages (user_id);

-- Newest-first pagination (GET /api/v1/messages ordered by created_at DESC)
CREATE INDEX IF NOT EXISTS idx_messages_user_created
  ON public.messages (user_id, created_at DESC);

-- Thread-based lookups (POST /api/v1/messages with threadId)
CREATE INDEX IF NOT EXISTS idx_messages_thread_id
  ON public.messages (thread_id);

-- Label filtering (GET /api/v1/messages?labelId=INBOX)
CREATE INDEX IF NOT EXISTS idx_messages_label_ids
  ON public.messages USING GIN (label_ids);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
-- The server always uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS). RLS is
-- defined here as a defence-in-depth layer — it prevents any anon/authenticated
-- Supabase client from accessing another user's data.
--
-- Policy creation is wrapped in DO blocks for idempotency; pg_policies is
-- checked before issuing CREATE POLICY so re-runs are safe.

ALTER TABLE public.users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'users' AND policyname = 'users_self'
  ) THEN
    CREATE POLICY users_self ON public.users
      USING     (id = auth.uid())
      WITH CHECK (id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'messages_own'
  ) THEN
    CREATE POLICY messages_own ON public.messages
      USING     (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
