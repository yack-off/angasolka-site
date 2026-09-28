CREATE TABLE catalog (
  id text PRIMARY KEY,
  title text NOT NULL,
  unit text NOT NULL,
  price_minor integer NOT NULL CHECK(price_minor >= 0),
  active boolean NOT NULL DEFAULT true
);
INSERT INTO catalog(id,title,unit,price_minor) VALUES
('bed','Койко-место','место / ночь',150000),
('climb','Скалолазание','человек / занятие',250000),
('mountain','Обучение альпинизму','человек / занятие',350000),
('walk','Туристический маршрут','человек / маршрут',180000),
('bath','Баня','час / вся компания',200000),
('food','Обед','порция',65000);
CREATE TABLE pricing_policy (
  id integer PRIMARY KEY CHECK(id=1),
  version integer NOT NULL CHECK(version > 0),
  demo boolean NOT NULL DEFAULT true,
  discount_nights integer NOT NULL CHECK(discount_nights > 0),
  discount_percent integer NOT NULL CHECK(discount_percent BETWEEN 0 AND 100)
);
INSERT INTO pricing_policy VALUES(1,1,true,5,10);
CREATE TABLE customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','contacted','cancelled')),
  source text NOT NULL CHECK(source IN ('website','admin','crm','bot')),
  arrival date NOT NULL,
  departure date NOT NULL CHECK(departure > arrival),
  beds integer NOT NULL CHECK(beds BETWEEN 0 AND 20),
  comment text NOT NULL,
  quote jsonb NOT NULL,
  total_minor integer NOT NULL CHECK(total_minor > 0),
  tracking_hash text NOT NULL UNIQUE,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX orders_status_created ON orders(status,created_at DESC);
CREATE INDEX orders_customer ON orders(customer_id);
CREATE TABLE order_items (
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id text NOT NULL REFERENCES catalog(id),
  title text NOT NULL,
  unit text NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),
  unit_price_minor integer NOT NULL CHECK(unit_price_minor>=0),
  total_minor integer NOT NULL CHECK(total_minor>=0),
  PRIMARY KEY(order_id,product_id)
);
CREATE TABLE order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  event_type text NOT NULL,
  actor text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES order_events(id),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE idempotency_keys (
  key_hash text PRIMARY KEY,
  request_hash text NOT NULL,
  order_id uuid UNIQUE REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
