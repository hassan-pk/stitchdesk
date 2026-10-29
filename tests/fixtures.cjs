// Synthetic fixtures for isolated desktop tests and public screenshots.
// Pass a Store constructed with a temporary data directory, never a live database.
const assert = require('node:assert/strict');
const round = value => Math.round(value * 100) / 100;

function valuesFor(entity, records, suffix = 'A') {
  const values = {};
  for (const field of entity.fields) {
    if (field.type === 'reference') {
      const target = records.get(field.reference);
      if (!target && field.required) throw new Error(`Cannot seed ${entity.key}.${field.key}: missing ${field.reference}`);
      values[field.key] = target ? target.id : '';
    } else if (field.type === 'lines') {
      const target = records.get(field.reference);
      values[field.key] = target ? [{ productId: target.id, quantity: 2, price: Number(target.values[field.priceField || 'price']) || 100 }] : [];
    } else if (field.type === 'checkbox') values[field.key] = field.default ?? false;
    else if (field.type === 'image') values[field.key] = '';
    else if (field.type === 'select') values[field.key] = field.default || (field.options || [])[0] || '';
    else if (field.type === 'number' || field.type === 'money') {
      let value = field.type === 'money' ? 100 : /stock|capacity/.test(field.key.toLowerCase()) ? 100 : /year/i.test(field.key) ? 2024 : /quantity|days/i.test(field.key) ? 1 : 10;
      value = Math.max(field.min === undefined ? 0 : field.min, value);
      if (field.max !== undefined) value = Math.min(field.max, value);
      if (field.integer) value = Math.floor(value);
      values[field.key] = value;
    } else if (field.type === 'date') values[field.key] = !field.required && /actualReturn/i.test(field.key) ? '' : field.key === (entity.booking || {}).end ? '2030-01-12' : '2030-01-10';
    else if (field.type === 'datetime-local') values[field.key] = field.key === (entity.booking || {}).end ? '2030-01-10T11:00' : '2030-01-10T10:00';
    else values[field.key] = /month|period/i.test(field.key) ? '2030-01' : `${field.label} demo ${suffix}`;
    if (entity.workflow && field.key === entity.workflow.field) values[field.key] = entity.workflow.initial;
  }
  for (const calculation of entity.calculations || []) {
    const number = key => Number(values[key] || 0);
    let result = 0;
    if (calculation.op === 'sumLines') result = values[calculation.fields[0]].reduce((sum, line) => sum + line.quantity * line.price, 0);
    else if (calculation.op === 'multiply') result = calculation.fields.reduce((total, key) => total * number(key), 1);
    else if (calculation.op === 'percent') result = number(calculation.fields[0]) * number(calculation.fields[1]) / 100;
    else result = calculation.fields.reduce((total, key) => total + number(key), 0);
    values[calculation.target] = round(result);
  }
  // Initial payments are always zero. A test can explicitly add an advance.
  if (entity.finance) values[entity.finance.paid] = 0;
  return values;
}

function seed(store, config) {
  const records = new Map();
  const remaining = [...config.entities];
  while (remaining.length) {
    const position = remaining.findIndex(entity => entity.fields.every(field => !['reference', 'lines'].includes(field.type) || !field.required || records.has(field.reference)));
    if (position < 0) throw new Error('Required reference cycle or missing entity');
    const [entity] = remaining.splice(position, 1);
    const before = new Set(store.snapshot().records.map(record => record.id));
    const result = store.save(entity.key, null, valuesFor(entity, records));
    const created = result.records.find(record => record.entity === entity.key && !before.has(record.id));
    assert.ok(created, `Created ${entity.label}`);
    records.set(entity.key, created);
  }
  return records;
}

module.exports = { seed, valuesFor };
