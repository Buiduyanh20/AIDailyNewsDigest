-- Phase 5: AI processing (event clustering + Vietnamese summary).
-- Additive only; no existing data is rewritten.

-- Article AI processing lifecycle.
ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_processing_status_check;
ALTER TABLE articles
  ADD CONSTRAINT articles_processing_status_check
  CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed'));

-- Internal AI metadata for debugging/evaluation (never exposed in the UI).
ALTER TABLE processing_attempts
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS target_event_id uuid,
  ADD COLUMN IF NOT EXISTS total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0);

-- Exact-duplicate lookup across sources and candidate/event queries.
CREATE INDEX IF NOT EXISTS articles_canonical_url_idx ON articles (canonical_url) WHERE canonical_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_user_last_seen_idx ON events (user_id, last_seen_at DESC, id);
CREATE INDEX IF NOT EXISTS processing_attempts_entity_operation_idx
  ON processing_attempts (entity_type, entity_id, operation, attempt_number);
