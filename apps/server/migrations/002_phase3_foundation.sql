CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  website_url text NOT NULL,
  rss_url text,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error')),
  last_fetched_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sources_user_id_idx ON sources (user_id);
CREATE INDEX IF NOT EXISTS sources_user_enabled_idx ON sources (user_id, enabled);
CREATE INDEX IF NOT EXISTS sources_user_deleted_idx ON sources (user_id, deleted_at);
CREATE INDEX IF NOT EXISTS sources_status_idx ON sources (status);

CREATE TABLE IF NOT EXISTS articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  external_id text,
  canonical_url text,
  original_url text NOT NULL,
  original_title text NOT NULL,
  original_language text,
  original_excerpt text,
  original_content text,
  published_at timestamptz,
  published_date_jst date,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  processing_status text NOT NULL DEFAULT 'pending',
  processing_error_code text,
  late_arrival boolean NOT NULL DEFAULT false,
  missed_digest_cutoff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_source_id_idx ON articles (source_id);
CREATE INDEX IF NOT EXISTS articles_processing_status_idx ON articles (processing_status);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title_vi text NOT NULL,
  summary_vi text,
  status text NOT NULL,
  processing_status text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  prompt_version text,
  model text,
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_user_id_idx ON events (user_id);

CREATE TABLE IF NOT EXISTS event_articles (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  association_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, article_id),
  UNIQUE (article_id)
);

CREATE TABLE IF NOT EXISTS daily_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  local_date date NOT NULL,
  status text NOT NULL
    CHECK (status IN ('scheduled', 'building', 'ready', 'sending', 'sent', 'failed')),
  built_at timestamptz,
  sent_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date)
);

CREATE TABLE IF NOT EXISTS digest_events (
  digest_id uuid NOT NULL REFERENCES daily_digests(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position > 0),
  title_vi_snapshot text NOT NULL,
  summary_vi_snapshot text NOT NULL,
  article_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(article_snapshot) = 'array'),
  source_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_snapshot) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (digest_id, event_id),
  UNIQUE (digest_id, position)
);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_id uuid NOT NULL REFERENCES daily_digests(id) ON DELETE RESTRICT,
  provider text,
  provider_message_id text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'accepted', 'delivered', 'failed', 'unknown')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  last_error_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (digest_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS outbox_events_status_available_idx
  ON outbox_events (status, available_at);

CREATE TABLE IF NOT EXISTS processing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL,
  provider text,
  model text,
  prompt_version text,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost numeric(14, 6),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processing_attempts_entity_idx
  ON processing_attempts (entity_type, entity_id, created_at);
