CREATE TABLE staff (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('owner','manager','viewer')),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 failed_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE staff_sessions (
 token_hash text PRIMARY KEY, staff_id uuid NOT NULL REFERENCES staff(id),
 expires_at timestamptz NOT NULL
);
CREATE INDEX staff_sessions_expiry ON staff_sessions(expires_at);
CREATE TABLE admin_audit (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES staff(id),
 action text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created ON admin_audit(created_at DESC);
CREATE TABLE content_blocks (
 id text PRIMARY KEY, title text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 sort_order integer NOT NULL, fields jsonb NOT NULL, custom boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media (
 id uuid PRIMARY KEY, title text NOT NULL, alt text NOT NULL, mime text NOT NULL,
 bytes bytea NOT NULL, size integer NOT NULL, width integer NOT NULL, height integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metric_daily (
 day date NOT NULL, event text NOT NULL CHECK(event IN ('page_view','quote')),
 count bigint NOT NULL DEFAULT 0, PRIMARY KEY(day,event)
);
ALTER TABLE customers ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE catalog ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE catalog ADD COLUMN category text NOT NULL DEFAULT 'adventure' CHECK(category IN ('adventure','comfort'));
ALTER TABLE catalog ADD COLUMN image_url text NOT NULL DEFAULT '';
ALTER TABLE catalog ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
UPDATE catalog SET category='comfort' WHERE id IN ('bed','bath','food');
UPDATE catalog SET description='Знакомство со скалолазанием под руководством инструктора. Программу и снаряжение согласуем перед занятием.' WHERE id='climb';
UPDATE catalog SET description='Основы альпинизма: работа с верёвкой, узлами и страховкой. Формат занятия зависит от подготовки участников.' WHERE id='mountain';
UPDATE catalog SET description='Пешая прогулка с сопровождающим. Маршрут и нагрузку подбираем с учётом погоды и возможностей группы.' WHERE id='walk';
UPDATE catalog SET description='Добавьте в поездку время для бани. Выбирайте количество часов, вместимость и свободное время уточняются отдельно.' WHERE id='bath';
UPDATE catalog SET description='Укажите общее количество порций на поездку, а меню и пожелания согласуем отдельно.' WHERE id='food';
