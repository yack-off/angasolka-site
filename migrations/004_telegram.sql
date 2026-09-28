CREATE TABLE telegram_updates (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_sessions (
  user_id bigint PRIMARY KEY,
  draft jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_orders (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  user_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_orders_user ON telegram_orders(user_id);
CREATE TABLE telegram_deliveries (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  dedupe_key text NOT NULL UNIQUE,
  user_id bigint NOT NULL,
  staff_id uuid REFERENCES staff(id),
  body jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  delivered_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_deliveries_pending ON telegram_deliveries(available_at) WHERE delivered_at IS NULL;
CREATE TABLE telegram_events (
  event_id uuid PRIMARY KEY REFERENCES order_events(id),
  queued_at timestamptz NOT NULL DEFAULT now()
);
