-- Phase 6: Daily Digest + email delivery. Additive; no existing rows are rewritten.

-- The rendered email is frozen on the delivery row when it is created (07:00 JST),
-- so retries resend byte-identical content to the recipient chosen at that time.
ALTER TABLE email_deliveries
  ADD COLUMN IF NOT EXISTS recipient_email text,
  ADD COLUMN IF NOT EXISTS sender_email text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS html_body text,
  ADD COLUMN IF NOT EXISTS text_body text;

CREATE INDEX IF NOT EXISTS email_deliveries_provider_message_idx
  ON email_deliveries (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS daily_digests_user_date_idx ON daily_digests (user_id, local_date DESC);

-- Webhook de-duplication (signed provider events are applied at most once).
CREATE TABLE IF NOT EXISTS email_webhook_events (
  id text PRIMARY KEY,
  provider text NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Immutability guard 1: snapshots may change only while the Digest is still building.
CREATE OR REPLACE FUNCTION digest_events_guard() RETURNS trigger AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM daily_digests
  WHERE id = COALESCE(NEW.digest_id, OLD.digest_id);
  IF parent_status IS NOT NULL AND parent_status NOT IN ('scheduled', 'building') THEN
    RAISE EXCEPTION 'digest_events are immutable once the digest is %', parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS digest_events_immutable ON digest_events;
CREATE TRIGGER digest_events_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON digest_events
  FOR EACH ROW EXECUTE FUNCTION digest_events_guard();

-- Immutability guard 2: a Digest keeps its identity, and a sent Digest never changes status.
CREATE OR REPLACE FUNCTION daily_digests_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.local_date <> OLD.local_date THEN
    RAISE EXCEPTION 'daily_digests identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sent' AND NEW.status <> 'sent' THEN
    RAISE EXCEPTION 'a sent digest is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS daily_digests_immutable ON daily_digests;
CREATE TRIGGER daily_digests_immutable
  BEFORE UPDATE ON daily_digests
  FOR EACH ROW EXECUTE FUNCTION daily_digests_guard();

-- Immutability guard 3: the logical email (identity + content + recipient) never changes.
CREATE OR REPLACE FUNCTION email_deliveries_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.digest_id <> OLD.digest_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
     OR NEW.sender_email IS DISTINCT FROM OLD.sender_email
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.html_body IS DISTINCT FROM OLD.html_body
     OR NEW.text_body IS DISTINCT FROM OLD.text_body THEN
    RAISE EXCEPTION 'email delivery content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_deliveries_immutable ON email_deliveries;
CREATE TRIGGER email_deliveries_immutable
  BEFORE UPDATE ON email_deliveries
  FOR EACH ROW EXECUTE FUNCTION email_deliveries_guard();
