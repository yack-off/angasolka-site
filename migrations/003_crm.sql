ALTER TABLE orders ADD COLUMN assignee_id uuid REFERENCES staff(id);
CREATE INDEX orders_assignee ON orders(assignee_id,status,created_at DESC);
CREATE TABLE crm_notes (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
 author_id uuid NOT NULL REFERENCES staff(id), body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_notes_order ON crm_notes(order_id,created_at DESC,id);
CREATE TABLE crm_tasks (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
 author_id uuid NOT NULL REFERENCES staff(id), assignee_id uuid NOT NULL REFERENCES staff(id),
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200), due_date date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK((status='done')=(completed_at IS NOT NULL))
);
CREATE INDEX crm_tasks_due ON crm_tasks(status,due_date,assignee_id);
CREATE INDEX crm_tasks_order ON crm_tasks(order_id,status,due_date,id);
