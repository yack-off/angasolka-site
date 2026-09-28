import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { connectDatabase, migrate, type Database } from '../src/db.js';
import { createOrder } from '../src/orders.js';
import { localToday } from '../src/pricing.js';

let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
const addDays = (day: string, days: number) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const trip = () => ({ arrival: addDays(localToday(), 10), departure: addDays(localToday(), 12), beds: 2, extras: { food: 3 } });
const token = () => randomBytes(32).toString('hex');
const phone = () => '+7' + String(randomBytes(5).readUIntBE(0, 5)).padStart(10, '0').slice(0, 10);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const count = async (table: string) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

async function payload() {
  const dates = trip();
  const response = await app.inject({ method: 'POST', url: '/api/v1/quotes', payload: dates });
  assert.equal(response.statusCode, 200);
  const quote = response.json();
  return { ...dates, customer: { name: '  Синтетический гость  ', phone: phone() }, comment: 'Проверка', consent: true as const,
    expectedTotalMinor: quote.totalMinor as number, pricingVersion: quote.pricingVersion as number, trackingToken: token() };
}
const submit = async (body: unknown, key?: string) => await app.inject({ method: 'POST', url: '/api/v1/orders', headers: key ? { 'idempotency-key': key } : {}, payload: body as Record<string, unknown> });

before(async () => {
  db = await connectDatabase(undefined, 'memory://');
  await migrate(db);
  app = await buildApp(db, { rateMax: 10000 });
  await app.ready();
});
after(async () => { await app.close(); await db.close(); });

test('BE-01 catalog matches active database rows and policy', async () => {
  const response = await app.inject({ url: '/api/v1/catalog' });
  assert.equal(response.statusCode, 200);
  const actual = response.json();
  const products = (await db.query('SELECT id,title,unit,price_minor,description,category,image_url,sort_order FROM catalog WHERE active=true ORDER BY sort_order,id')).rows;
  const policy = (await db.query('SELECT version,demo,discount_nights,discount_percent FROM pricing_policy WHERE id=1')).rows[0];
  assert.deepEqual(actual.products, products);
  assert.deepEqual(actual.policy, policy);
  assert.equal(actual.currency, 'RUB');
  assert.equal(actual.timezone, 'Asia/Irkutsk');
});

test('BE-01/17 readiness fails closed when database query fails; health stays live', async () => {
  const unavailable: Database = { ...db, query: async (sql, params) => {
    if (sql.startsWith('SELECT version FROM schema_migrations')) throw new Error('injected database failure');
    return db.query(sql, params);
  } };
  const probe = await buildApp(unavailable);
  try {
    assert.equal((await probe.inject({ url: '/api/v1/health' })).statusCode, 200);
    const ready = await probe.inject({ url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 500);
    assert.equal(ready.json().error.code, 'REQUEST_FAILED');
    assert.ok(!ready.body.includes('injected database failure'));
  } finally { await probe.close(); }
});

test('BE-02 independent price formula at and below discount threshold; quotes do not create orders', async () => {
  const catalog = (await app.inject({ url: '/api/v1/catalog' })).json();
  const bed = catalog.products.find((p: { id: string }) => p.id === 'bed');
  const food = catalog.products.find((p: { id: string }) => p.id === 'food');
  assert.ok(bed && food);
  const beforeOrders = await count('orders');
  for (const nights of [catalog.policy.discount_nights - 1, catalog.policy.discount_nights]) {
    assert.ok(nights >= 1);
    const dates = trip();
    const response = await app.inject({ method: 'POST', url: '/api/v1/quotes', payload: { ...dates, departure: addDays(dates.arrival, nights) } });
    assert.equal(response.statusCode, 200);
    const quote = response.json();
    const stay = bed.price_minor * dates.beds * nights;
    const service = food.price_minor * dates.extras.food;
    const discount = nights >= catalog.policy.discount_nights ? Math.round(stay * catalog.policy.discount_percent / 100) : 0;
    assert.equal(quote.subtotalMinor, stay + service);
    assert.equal(quote.discountMinor, discount);
    assert.equal(quote.totalMinor, stay + service - discount);
    assert.equal(quote.availability, 'requires_confirmation');
    assert.ok(Number.isInteger(quote.totalMinor));
  }
  assert.equal(await count('orders'), beforeOrders);
});

test('BE-05 rejects server-owned and unknown nested order fields without writes', async () => {
  const body = await payload();
  const beforeOrders = await count('orders');
  for (const extra of [{ source: 'admin' }, { status: 'confirmed' }, { role: 'owner' }, { assigneeId: randomUUID() },
    { items: [{ productId: 'bed', unitPriceMinor: 1 }] }, { customer: { ...body.customer, id: randomUUID() } }, { extras: { ...body.extras, price: 1 } }]) {
    const response = await submit({ ...body, ...extra }, randomUUID());
    assert.equal(response.statusCode, 400, JSON.stringify(extra));
  }
  const { consent: _consent, ...missing } = body;
  assert.equal((await submit(missing, randomUUID())).statusCode, 400);
  assert.equal(await count('orders'), beforeOrders);
});

test('BE-07/08/13 order snapshot, hash, transaction, sequential replay and minimal status', async () => {
  const body = await payload();
  const key = randomUUID();
  const created = await submit(body, key);
  assert.equal(created.statusCode, 201, created.body);
  const orderId = created.json().order.id as string;
  const saved = (await db.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  const customer = (await db.query('SELECT * FROM customers WHERE id=$1', [saved.customer_id])).rows[0];
  const items = (await db.query('SELECT * FROM order_items WHERE order_id=$1', [orderId])).rows;
  const events = (await db.query('SELECT * FROM order_events WHERE order_id=$1', [orderId])).rows;
  const outbox = (await db.query("SELECT * FROM outbox WHERE payload->>'orderId'=$1", [orderId])).rows;
  assert.equal(saved.source, 'website');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.total_minor, body.expectedTotalMinor);
  assert.equal(saved.quote.totalMinor, body.expectedTotalMinor);
  assert.equal(saved.tracking_hash, sha(body.trackingToken));
  assert.notEqual(saved.tracking_hash, body.trackingToken);
  assert.equal(customer.name, body.customer.name.trim());
  assert.equal(customer.phone, body.customer.phone);
  assert.equal(items.length, saved.quote.items.length);
  for (const quoted of saved.quote.items) {
    const item = items.find(row => row.product_id === quoted.productId);
    assert.ok(item);
    assert.equal(item.quantity, quoted.quantity);
    assert.equal(item.unit_price_minor, quoted.unitPriceMinor);
    assert.equal(item.total_minor, quoted.totalMinor);
  }
  assert.equal(events.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(events[0].event_type, 'order.created');
  assert.equal(outbox[0].event_id, events[0].id);
  const replay = await submit(body, key);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().order.id, orderId);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM order_events WHERE order_id=$1', [orderId])).rows[0].n, 1);
  for (const authorization of [undefined, 'Bearer invalid', 'Bearer ' + token().toUpperCase()]) {
    const response = await app.inject({ url: '/api/v1/orders/status', headers: authorization ? { authorization } : {} });
    assert.equal(response.statusCode, 401);
  }
  assert.equal((await app.inject({ url: '/api/v1/orders/status', headers: { authorization: 'Bearer ' + token() } })).statusCode, 404);
  for (const query of [`?id=${orderId}`, '?phone=0000000000']) {
    assert.equal((await app.inject({ url: '/api/v1/orders/status' + query })).statusCode, 401);
  }
  const status = await app.inject({ url: '/api/v1/orders/status', headers: { authorization: 'Bearer ' + body.trackingToken } });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(Object.keys(status.json()).sort(), ['availability', 'created_at', 'currency', 'id', 'status', 'total_minor'].sort());
});

test('BE-09/10 idempotency key bounds and failed price attempt releases the key', async () => {
  const keyApp = await buildApp(db, { rateMax: 10000 });
  await keyApp.ready();
  const submitKey = async (body: unknown, key?: string) => await keyApp.inject({ method: 'POST', url: '/api/v1/orders', headers: key ? { 'idempotency-key': key } : {}, payload: body as Record<string, unknown> });
  try {
  const body = await payload();
  for (const key of [undefined, 'a'.repeat(19), 'a'.repeat(101), 'bad key with spaces 1234']) {
    assert.equal((await submitKey(body, key)).statusCode, 400);
  }
  for (const key of ['a'.repeat(20), 'b'.repeat(100)]) {
    const fresh = await payload();
    assert.equal((await submitKey(fresh, key)).statusCode, 201);
  }
  const key = randomUUID();
  const before = await Promise.all(['customers', 'orders', 'order_items', 'order_events', 'outbox', 'idempotency_keys'].map(count));
  const changed = await submitKey({ ...body, expectedTotalMinor: body.expectedTotalMinor + 1 }, key);
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'PRICE_CHANGED');
  const after = await Promise.all(['customers', 'orders', 'order_items', 'order_events', 'outbox', 'idempotency_keys'].map(count));
  assert.deepEqual(after, before);
  assert.equal((await submitKey(body, key)).statusCode, 201);
  } finally { await keyApp.close(); }
});

test('BE-12 injected public-order event and outbox failures roll back and same keys can retry', async () => {
  const tables = ['customers', 'orders', 'order_items', 'order_events', 'outbox', 'idempotency_keys'];
  for (const prefix of ['INSERT INTO order_events', 'INSERT INTO outbox']) {
    const body = await payload();
    const key = randomUUID();
    const before = await Promise.all(tables.map(count));
    const failing: Database = { ...db, transaction: fn => db.transaction(tx => fn({ query: async (sql, params) => {
      if (sql.startsWith(prefix)) throw new Error('injected write failure');
      return tx.query(sql, params);
    } })) };
    await assert.rejects(createOrder(failing, body, key), /injected write failure/);
    assert.deepEqual(await Promise.all(tables.map(count)), before);
    const created = await createOrder(db, body, key);
    assert.equal(created.replayed, false);
    assert.equal(await count('orders'), before[1] + 1);
  }
});

test('BE-15 no-store, cross-site writes and sensitive paths', async () => {
  const catalog = await app.inject({ url: '/api/v1/catalog' });
  assert.equal(catalog.headers['cache-control'], 'no-store');
  assert.match(String(catalog.headers['content-security-policy']), /default-src 'self'/);
  const dates = trip();
  for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/quotes', headers, payload: dates })).statusCode, 403);
  }
  for (const url of ['/.env', '/src/orders.ts', '/migrations/001_initial.sql', '/%2e%2e/src/orders.ts']) {
    assert.notEqual((await app.inject({ url })).statusCode, 200);
  }
});
