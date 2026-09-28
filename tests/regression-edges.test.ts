import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { connectDatabase, migrate, type Database } from '../src/db.js';
import { localToday } from '../src/pricing.js';

let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
const addDays = (day: string, days: number) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const baseTrip = () => ({ arrival: addDays(localToday(), 7), departure: addDays(localToday(), 9), beds: 1, extras: {} });
const quoteTrip = async (trip: unknown) => app.inject({ method: 'POST', url: '/api/v1/quotes', payload: trip as Record<string, unknown> });
const count = async (table: string) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
const syntheticPhone = () => '+7' + String(randomBytes(5).readUIntBE(0, 5)).padStart(10, '0').slice(0, 10);

async function orderBody(phone: string) {
  const trip = baseTrip();
  const quote = (await quoteTrip(trip)).json();
  return { ...trip, customer: { name: 'Синтетический гость', phone }, comment: '', consent: true,
    expectedTotalMinor: quote.totalMinor, pricingVersion: quote.pricingVersion,
    trackingToken: randomBytes(32).toString('hex') };
}

before(async () => {
  db = await connectDatabase(undefined, 'memory://');
  await migrate(db);
  app = await buildApp(db, { rateMax: 10000 });
  await app.ready();
});
after(async () => { await app.close(); await db.close(); });

test('BE-03 calendar and stay-length boundary variants', async () => {
  const today = localToday();
  for (const trip of [
    { ...baseTrip(), arrival: addDays(today, -1), departure: today },
    { ...baseTrip(), arrival: addDays(today, 731), departure: addDays(today, 732) },
    { ...baseTrip(), departure: baseTrip().arrival },
    { ...baseTrip(), departure: addDays(baseTrip().arrival, 366) },
    { ...baseTrip(), arrival: '2026-02-30' },
    { ...baseTrip(), arrival: 'not-a-date' },
  ]) assert.equal((await quoteTrip(trip)).statusCode, 400);
  for (const trip of [
    { ...baseTrip(), arrival: today, departure: addDays(today, 1) },
    { ...baseTrip(), departure: addDays(baseTrip().arrival, 365) },
    { ...baseTrip(), arrival: addDays(today, 730), departure: addDays(today, 731) },
  ]) assert.equal((await quoteTrip(trip)).statusCode, 200);
});

test('BE-04 quantity, type, empty-trip and unavailable-service variants', async () => {
  const trip = baseTrip();
  const invalid = [
    { ...trip, beds: -1 }, { ...trip, beds: 21 }, { ...trip, beds: 1.5 },
    { ...trip, beds: '1' }, { ...trip, beds: null },
    { ...trip, beds: 0, extras: { food: -1 } },
    { ...trip, beds: 0, extras: { food: 101 } },
    { ...trip, beds: 0, extras: { food: 1.5 } },
    { ...trip, beds: 0, extras: { food: '1' } },
    { ...trip, beds: 0, extras: { food: null } },
  ];
  for (const body of invalid) assert.equal((await quoteTrip(body)).statusCode, 400);
  for (const body of [
    { ...trip, beds: 1 }, { ...trip, beds: 20 },
    { ...trip, beds: 0, extras: { food: 1 } },
    { ...trip, beds: 0, extras: { food: 100 } },
  ]) assert.equal((await quoteTrip(body)).statusCode, 200);
  assert.equal((await quoteTrip({ ...trip, beds: 0 })).json().error.code, 'EMPTY_ORDER');
  assert.equal((await quoteTrip({ ...trip, beds: 0, extras: { unknown: 1 } })).json().error.code, 'SERVICE_UNAVAILABLE');
  await db.query("UPDATE catalog SET active=false WHERE id='food'");
  try {
    assert.equal((await quoteTrip({ ...trip, beds: 0, extras: { food: 1 } })).json().error.code, 'SERVICE_UNAVAILABLE');
  } finally { await db.query("UPDATE catalog SET active=true WHERE id='food'"); }
});

test('BE-14 unverified equal phone creates separate customers and secrets', async () => {
  const phone = syntheticPhone();
  const before = await count('customers');
  const bodies = [await orderBody(phone), await orderBody(phone)];
  const ids: string[] = [];
  for (const body of bodies) {
    const result = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { 'idempotency-key': randomUUID() }, payload: body });
    assert.equal(result.statusCode, 201);
    ids.push(result.json().order.id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(await count('customers'), before + 2);
  const rows = (await db.query('SELECT customer_id,tracking_hash FROM orders WHERE id=$1 OR id=$2', ids)).rows;
  assert.equal(new Set(rows.map(row => row.customer_id)).size, 2);
  assert.equal(new Set(rows.map(row => row.tracking_hash)).size, 2);
});

test('BE-23 fractional-kopeck discount, zero total and large subtotal', async () => {
  const originalPrice = (await db.query("SELECT price_minor FROM catalog WHERE id='bed'")).rows[0].price_minor;
  const originalPolicy = (await db.query('SELECT discount_nights,discount_percent FROM pricing_policy WHERE id=1')).rows[0];
  const trip = { ...baseTrip(), departure: addDays(baseTrip().arrival, 1) };
  try {
    await db.query("UPDATE catalog SET price_minor=3 WHERE id='bed'");
    await db.query('UPDATE pricing_policy SET discount_nights=1,discount_percent=50 WHERE id=1');
    const fractional = (await quoteTrip(trip)).json();
    assert.equal(fractional.subtotalMinor, 3);
    assert.equal(fractional.discountMinor, 2);
    assert.equal(fractional.totalMinor, 1);
    await db.query("UPDATE catalog SET price_minor=1 WHERE id='bed'");
    assert.equal((await quoteTrip(trip)).json().error.code, 'TOTAL_OUT_OF_RANGE');
    await db.query("UPDATE catalog SET price_minor=10000000 WHERE id='bed'");
    await db.query('UPDATE pricing_policy SET discount_percent=0 WHERE id=1');
    const large = { ...trip, beds: 20, departure: addDays(trip.arrival, 10) };
    assert.equal((await quoteTrip(large)).json().totalMinor, 2000000000);
    assert.equal((await quoteTrip({ ...large, departure: addDays(trip.arrival, 11) })).json().error.code, 'TOTAL_OUT_OF_RANGE');
  } finally {
    await db.query("UPDATE catalog SET price_minor=$1 WHERE id='bed'", [originalPrice]);
    await db.query('UPDATE pricing_policy SET discount_nights=$1,discount_percent=$2 WHERE id=1', [originalPolicy.discount_nights, originalPolicy.discount_percent]);
  }
});
