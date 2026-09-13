-- VibeMail — Drop watch_resource_id
-- Idempotent: safe to run multiple times on the same database (AC-9).
-- DO NOT apply to production until npm test exits 0 on main (CONTRACT.md §2).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Drop column
-- ─────────────────────────────────────────────────────────────────────────────
-- watch_resource_id was modeled on the Drive/Calendar push-channel pattern.
-- Gmail's watch response has no resourceId, and Gmail's Pub/Sub push payload
-- carries no X-Goog-Resource-ID header, so the column was always written as
-- null and never populated by anything.

ALTER TABLE public.users
  DROP COLUMN IF EXISTS watch_resource_id;
