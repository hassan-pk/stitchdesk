import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rawConfig from '../src/business.json';
import { Store } from '../src/main/store';
import type { BusinessConfig, Entity, Line, RecordData, Value } from '../src/shared/types';

const config = rawConfig as BusinessConfig;
const secret = 'synthetic-business-test-password';
const round = (value: number) => Math.round(value * 100) / 100;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), `${config.id}-integration-`));
  const file = join(directory, 'business.sqlite');
  const store = new Store(file, config);
  store.setup({ shop: { name: 'Synthetic Test Business', phone: '000-000-0000', address: 'Demo Street', currency: 'PKR', footer: 'Test document' }, name: 'Test Owner', username: 'test-owner', password: secret });
  return { store, directory, file };
}

function valuesFor(entity: Entity, records: Map<string, RecordData>, suffix = 'A'): Record<string, Value> {
  const values: Record<string, Value> = {};
  for (const field of entity.fields) {
    if (field.type === 'reference') {
      const target = records.get(field.reference!);
      if (!target && field.required) throw new Error(`Test seed cannot resolve ${entity.key}.${field.key} -> ${field.reference}`);
      values[field.key] = target?.id || '';
    } else if (field.type === 'lines') {
      const target = records.get(field.reference!);
      values[field.key] = target ? [{ productId: target.id, quantity: 2, price: Number(target.values[field.priceField || 'price']) || 100 }] : [];
    } else if (field.type === 'checkbox') values[field.key] = true;
    else if (field.type === 'image') values[field.key] = '';
    else if (field.type === 'select') values[field.key] = field.options?.[0] || '';
    else if (field.type === 'number') {
      values[field.key] = /stock|capacity/.test(field.key.toLowerCase()) ? 100 : /year/i.test(field.key) ? 2024 : Math.max(field.min ?? 0, /quantity|days/i.test(field.key) ? 1 : 10);
    } else if (field.type === 'money') values[field.key] = 100;
    else if (field.type === 'date') values[field.key] = field.key === entity.booking?.end ? '2030-01-12' : '2030-01-10';
    else if (field.type === 'datetime-local') values[field.key] = field.key === entity.booking?.end ? '2030-01-10T11:00' : '2030-01-10T10:00';
    else values[field.key] = /month|period/i.test(field.key) ? '2030-01' : `${field.label} synthetic ${suffix}`;
    if (field.key === entity.workflow?.field) values[field.key] = entity.workflow.initial;
  }
  for (const calculation of entity.calculations || []) {
    const number = (key: string) => Number(values[key] || 0);
    let result = 0;
    if (calculation.op === 'sumLines') result = (values[calculation.fields[0]] as Line[]).reduce((sum, line) => sum + line.quantity * line.price, 0);
    else if (calculation.op === 'multiply') result = calculation.fields.reduce((total, key) => total * number(key), 1);
    else if (calculation.op === 'percent') result = number(calculation.fields[0]) * number(calculation.fields[1]) / 100;
    else result = calculation.fields.reduce((total, key) => total + number(key), 0);
    values[calculation.target] = round(result);
  }
  if (entity.finance) values[entity.finance.paid] = Math.min(10, round(Number(values[entity.finance.total]) / 2));
  return values;
}

function seed(store: Store) {
  const records = new Map<string, RecordData>();
  const remaining = [...config.entities];
  while (remaining.length) {
    const position = remaining.findIndex(entity => entity.fields.every(field => !['reference', 'lines'].includes(field.type) || !field.required || records.has(field.reference!)));
    if (position < 0) throw new Error('Required reference cycle or missing entity in business configuration');
    const [entity] = remaining.splice(position, 1);
    const before = new Set(store.snapshot().records.map(record => record.id));
    const result = store.save(entity.key, null, valuesFor(entity, records));
    const created = result.records.find(record => record.entity === entity.key && !before.has(record.id));
    assert.ok(created, `Created ${entity.label}`);
    records.set(entity.key, created);
  }
  return records;
}

test(`${config.name}: every configured module supports real create, read and edit`, () => {
  const { store, directory } = fixture();
  try {
    const records = seed(store);
    assert.equal(records.size, config.entities.length);
    for (const entity of config.entities) {
      const created = store.snapshot().records.find(record => record.id === records.get(entity.key)!.id)!;
      assert.equal(created.number, 1);
      if (entity.workflow) {
        const calculatedPaymentState = entity.finance && ['Due', 'Part-paid', 'Settled'].every(state => entity.workflow!.states.includes(state));
        assert.equal(created.values[entity.workflow.field], calculatedPaymentState ? Number(created.values[entity.finance!.paid]) >= Number(created.values[entity.finance!.total]) ? 'Settled' : Number(created.values[entity.finance!.paid]) > 0 ? 'Part-paid' : 'Due' : entity.workflow.initial);
      }
      const field = entity.fields.find(field => ['text', 'textarea'].includes(field.type) && field.key !== entity.primary) || entity.fields.find(field => field.type === 'text');
      if (field && !entity.workflow?.terminal.includes(String(created.values[entity.workflow.field]))) {
        const changed = { ...created.values, [field.key]: 'Edited synthetic record' };
        const result = store.save(entity.key, created.id, changed);
        const edited = result.records.find(record => record.id === created.id)!;
        assert.equal(edited.values[field.key], 'Edited synthetic record');
        assert.equal(edited.number, created.number);
        assert.equal(edited.createdAt, created.createdAt);
      }
      for (const field of entity.fields.filter(field => field.type === 'reference' && field.required)) {
        const before = store.snapshot().records.length;
        assert.throws(() => store.save(entity.key, null, { ...valuesFor(entity, records, 'bad'), [field.key]: 'nonexistent-record-id' }), /record|reference|found/i);
        assert.equal(store.snapshot().records.length, before);
      }
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test(`${config.name}: finance preserves identity, validates receipts and reconciles the payment ledger`, () => {
  const { store, directory } = fixture();
  try {
    const records = seed(store);
    const financial = config.entities.filter(entity => entity.finance);
    assert.ok(financial.length > 0, 'Business must have an actual financial workflow');
    for (const entity of financial) {
      const { total, paid } = entity.finance!;
      const record = store.snapshot().records.find(record => record.id === records.get(entity.key)!.id)!;
      const originalIdentity = record.values[entity.primary];
      assert.ok(Number(record.values[total]) > Number(record.values[paid]));
      assert.equal(store.snapshot().payments.filter(payment => payment.recordId === record.id).reduce((sum, payment) => sum + payment.amount, 0), Number(record.values[paid]));
      assert.throws(() => store.save(entity.key, record.id, { ...record.values, [paid]: Number(record.values[paid]) + 1 }), /Collect payment/i);
      const due = round(Number(record.values[total]) - Number(record.values[paid]));
      assert.throws(() => store.collect(record.id, due + 1, 'cash'), /outstanding|exceed/i);
      store.collect(record.id, due, 'bank');
      const collected = store.snapshot().records.find(candidate => candidate.id === record.id)!;
      assert.equal(collected.values[entity.primary], originalIdentity);
      assert.equal(collected.values[paid], collected.values[total]);
      if (entity.workflow && ['Due', 'Part-paid', 'Settled'].every(state => entity.workflow!.states.includes(state))) assert.equal(collected.values[entity.workflow.field], 'Settled');
      assert.equal(round(store.snapshot().payments.filter(payment => payment.recordId === record.id).reduce((sum, payment) => sum + payment.amount, 0)), Number(collected.values[total]));
      assert.throws(() => store.collect(record.id, 1, 'cash'), /outstanding|exceed/i);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test(`${config.name}: records and payments survive restart and backup restoration`, () => {
  const { store, directory, file } = fixture();
  let restarted: Store | undefined;
  try {
    seed(store);
    const expected = store.snapshot();
    const backup = join(directory, 'business-backup.sqlite');
    store.backupTo(backup);
    store.saveShop({ ...expected.shop!, name: 'Changed after backup' });
    store.restoreFrom(backup);
    assert.equal(store.snapshot().user, null);
    store.login('test-owner', secret);
    assert.equal(store.snapshot().shop!.name, 'Synthetic Test Business');
    assert.deepEqual(store.snapshot().records, expected.records);
    assert.deepEqual(store.snapshot().payments, expected.payments);
    store.close();
    restarted = new Store(file, config);
    assert.equal(restarted.snapshot().records.length, 0, 'Signed-out snapshot exposes no business records');
    restarted.login('test-owner', secret);
    assert.deepEqual(restarted.snapshot().records, expected.records);
    assert.deepEqual(restarted.snapshot().payments, expected.payments);
  } finally { try { store.close(); } catch {} restarted?.close(); rmSync(directory, { recursive: true, force: true }); }
});

if (config.id === 'counterdesk') test('CounterDesk: supplier receiving, retail selling and cancellation reconcile actual product stock', () => {
  const { store, directory } = fixture();
  try {
    const records = seed(store);
    const product = records.get('products')!;
    const current = () => Number(store.snapshot().records.find(record => record.id === product.id)!.values.stock);
    const start = current();
    const purchaseEntity = config.entities.find(entity => entity.key === 'purchases')!;
    const purchase = valuesFor(purchaseEntity, records, 'extra-purchase');
    purchase.items = [{ productId: product.id, quantity: 5, price: 40 }]; purchase.paid = 0;
    const purchaseIds = new Set(store.snapshot().records.map(record => record.id));
    store.save('purchases', null, purchase);
    const received = store.snapshot().records.find(record => record.entity === 'purchases' && !purchaseIds.has(record.id))!;
    assert.equal(current(), start + 5);
    assert.equal(received.values.amount, 200);
    const saleEntity = config.entities.find(entity => entity.key === 'sales')!;
    const sale = valuesFor(saleEntity, records, 'extra-sale');
    sale.items = [{ productId: product.id, quantity: 3, price: 1 }]; sale.paid = 0;
    const saleIds = new Set(store.snapshot().records.map(record => record.id));
    store.save('sales', null, sale);
    const sold = store.snapshot().records.find(record => record.entity === 'sales' && !saleIds.has(record.id))!;
    assert.equal(current(), start + 2);
    assert.equal(sold.values.amount, Number(product.values.price) * 3, 'Selling price comes from the catalog, not forged input');
    store.transition('sales', sold.id, 'Cancelled'); assert.equal(current(), start + 5);
    assert.throws(() => store.transition('sales', sold.id, 'Cancelled'), /reopen|cancelled|completed/i);
    store.transition('purchases', received.id, 'Cancelled'); assert.equal(current(), start);
    assert.throws(() => store.save('sales', null, { ...valuesFor(saleEntity, records, 'oversell'), paid: 0, items: [{ productId: product.id, quantity: start + 1, price: 1 }] }), /stock/i);
    assert.equal(current(), start);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
