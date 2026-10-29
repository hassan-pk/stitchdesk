// End-to-end pilot verification. Always uses its own temporary business database.
// Build first. Optional BUSINESS_TEST_EXECUTABLE tests a packaged executable.
// BUSINESS_SCREENSHOTS=1 writes public images made solely from synthetic records.
const { _electron: electron, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 12000 });
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { valuesFor } = require('./fixtures.cjs');
const config = require(path.resolve('business.json'));
const directory = mkdtempSync(path.join(tmpdir(), `${config.id}-desktop-`));
const env = { ...process.env, BUSINESS_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
const output = path.resolve(process.env.BUSINESS_SCREENSHOTS ? 'docs/screenshots' : 'test-results');
mkdirSync(output, { recursive: true });
mkdirSync(path.resolve('test-results'), { recursive: true });
const credentials = { username: 'pilot-owner', password: 'isolated-pilot-password-123' };
const records = new Map();
const errors = [];
let application;
let page;

async function launch() {
  application = await electron.launch(process.env.BUSINESS_TEST_EXECUTABLE
    ? { executablePath: path.resolve(process.env.BUSINESS_TEST_EXECUTABLE), args: [], env }
    : { args: [path.resolve('.')], env });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.desk);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
}
async function snapshot() { return page.evaluate(() => window.desk.snapshot()); }
async function navigate(key) {
  await page.locator(`[data-action="nav:${key}"]`).first().click();
}
async function capture(name) {
  await page.evaluate(async () => {
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    document.activeElement?.blur();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}
async function openRecord(record) {
  await navigate(record.entity);
  await page.locator(`[data-action="view:${record.id}"]`).first().click();
  await expect(page.locator('[role=dialog]')).toBeVisible();
}
async function login() {
  await page.locator('[data-form=login] [name=username]').fill(credentials.username);
  await page.locator('[data-form=login] [name=password]').fill(credentials.password);
  await page.locator('[data-form=login] button[type=submit]').click();
  await expect(page.locator('.sidebar')).toBeVisible();
}
function dependenciesReady(definition) {
  return definition.fields.every(field => !['reference', 'lines'].includes(field.type) || !field.required || records.has(field.reference));
}
async function createThroughForm(definition) {
  const values = valuesFor(definition, records, 'Desktop');
  await navigate(definition.key);
  await page.locator('[data-action=new]').first().click();
  const form = page.locator('[data-form=record]');
  await expect(form).toBeVisible();
  const calculated = new Set((definition.calculations || []).map(calculation => calculation.target));
  for (const field of definition.fields) {
    if (field.key === definition.workflow?.field || calculated.has(field.key)) continue;
    if (field.type === 'image') {
      await form.locator(`[data-image="${field.key}"]`).setInputFiles(path.resolve('build/icon.png'));
      await expect(form.locator(`[data-preview="${field.key}"] img`)).toBeVisible();
      await expect(form.locator('[type=submit]')).toBeEnabled();
      continue;
    }
    if (field.type === 'lines') {
      const section = form.locator(`[data-lines="${field.key}"]`);
      const lines = values[field.key];
      while (await section.locator('.line-row').count() > lines.length) await section.locator('[data-action=remove-line]').last().click();
      while (await section.locator('.line-row').count() < lines.length) await section.locator(`[data-action="add-line:${field.key}"]`).click();
      for (let index = 0; index < lines.length; index++) {
        const row = section.locator('.line-row').nth(index);
        await row.locator('[data-part=product]').selectOption(lines[index].productId);
        await row.locator('[data-part=quantity]').fill(String(lines[index].quantity));
        if (field.stockEffect === 1) await row.locator('[data-part=price]').fill(String(lines[index].price));
        else await expect(row.locator('[data-part=price]')).toHaveAttribute('readonly', '');
      }
      continue;
    }
    const control = form.locator(`[name="${field.key}"]`);
    if (field.type === 'checkbox') await control.setChecked(!!values[field.key]);
    else if (field.type === 'reference' || field.type === 'select') await control.selectOption(String(values[field.key] ?? ''));
    else await control.fill(String(values[field.key] ?? ''));
  }
  const before = new Set((await snapshot()).records.map(record => record.id));
  await form.locator('[type=submit]').click();
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  const saved = (await snapshot()).records.find(record => record.entity === definition.key && !before.has(record.id));
  assert.ok(saved, `Created ${definition.label} through the desktop form`);
  for (const field of definition.fields) {
    if (field.type === 'reference') assert.equal(saved.values[field.key], values[field.key], `Saved ${definition.key}.${field.key}`);
    if (field.type === 'image') assert.match(saved.values[field.key], /^data:image\//);
    if (field.type === 'lines') {
      assert.equal(saved.values[field.key].length, values[field.key].length);
      saved.values[field.key].forEach((line, index) => {
        assert.equal(line.productId, values[field.key][index].productId);
        assert.equal(line.quantity, values[field.key][index].quantity);
        assert.equal(line.price, values[field.key][index].price);
        assert.ok(line.name, 'Line has a saved human-readable item name');
      });
    }
  }
  for (const calculation of definition.calculations || []) assert.equal(saved.values[calculation.target], values[calculation.target], `Calculated ${definition.key}.${calculation.target}`);
  if (definition.workflow) assert.equal(saved.values[definition.workflow.field], definition.workflow.initial);
  records.set(definition.key, saved);
  return saved;
}

(async () => {
  await launch();
  const setup = page.locator('[data-form=setup]');
  await setup.locator('[name=name]').fill(`${config.name} Demo Business`);
  await setup.locator('[name=phone]').fill('000-000-0000');
  await setup.locator('[name=address]').fill('Synthetic Demo Market');
  await setup.locator('[name=ownerName]').fill('Demo Owner');
  await setup.locator('[name=username]').fill(credentials.username);
  await setup.locator('[name=password]').fill(credentials.password);
  await setup.locator('[type=submit]').click();
  await expect(page.locator('.sidebar')).toBeVisible();
  assert.equal((await snapshot()).records.length, 0, 'New business starts empty');
  const remaining = [...config.entities];
  while (remaining.length) {
    const index = remaining.findIndex(dependenciesReady);
    assert.notEqual(index, -1, 'All required entity dependencies can be resolved');
    await createThroughForm(remaining.splice(index, 1)[0]);
  }
  assert.equal(records.size, config.entities.length);
  await navigate('overview');
  await capture('overview');

  const definition = config.entities.find(def => def.finance && def.workflow && !def.fields.some(field => field.stockEffect === 1)) || config.entities.find(def => def.finance) || config.entities[0];
  let primary = records.get(definition.key);
  await navigate(definition.key);
  await page.locator('#search').fill('definitely-no-match-78321');
  await expect(page.locator(`[data-action="view:${primary.id}"]`)).toHaveCount(0);
  await page.locator('#search').fill('');
  await expect(page.locator(`[data-action="view:${primary.id}"]`)).toBeVisible();
  if (definition.workflow) {
    await page.locator('#status-filter').selectOption(definition.workflow.initial);
    await expect(page.locator(`[data-action="view:${primary.id}"]`)).toBeVisible();
    await page.locator('#status-filter').selectOption(definition.workflow.states[definition.workflow.states.length - 1]);
    await expect(page.locator(`[data-action="view:${primary.id}"]`)).toHaveCount(0);
    await page.locator('#status-filter').selectOption('');
  }
  await capture('workspace');
  await page.locator(`[data-action="view:${primary.id}"]`).click();
  await capture('record');
  await page.locator('[data-action=preview]').click();
  const preview = page.frameLocator('.document-preview').locator('body');
  await expect(preview).toContainText(`${config.name} Demo Business`);
  await expect(preview).toContainText(definition.singular);
  for (const field of definition.fields.filter(field => field.type === 'reference' && primary.values[field.key])) {
    const related = (await snapshot()).records.find(record => record.id === primary.values[field.key]);
    const relatedDefinition = config.entities.find(def => def.key === related.entity);
    const relatedPrimary = relatedDefinition.fields.find(f => f.key === relatedDefinition.primary);
    if (relatedPrimary.type !== 'reference') await expect(preview).toContainText(String(related.values[relatedDefinition.primary]));
  }
  await capture('document');
  await application.evaluate(({ app }) => {
    globalThis.businessPrintCalls = 0;
    app.on('browser-window-created', (_event, win) => {
      win.webContents.print = (_options, callback) => { globalThis.businessPrintCalls++; callback(false, 'Print job canceled'); };
    });
  });
  await page.locator('[data-action=print]').click();
  await expect(page.locator('[data-action=print]')).toBeEnabled();
  assert.equal(await application.evaluate(() => globalThis.businessPrintCalls), 1, 'Native print pipeline called; cancellation is harmless');
  await page.locator(`.modal [data-action="view:${primary.id}"]`).click();
  if (definition.finance) {
    const due = Number(primary.values[definition.finance.total]) - Number(primary.values[definition.finance.paid]);
    if (due > 0) {
      const payment = page.locator('[data-form=payment]');
      await payment.locator('[name=amount]').fill(String(due + 1));
      await payment.locator('button').click();
      await expect(page.locator('.modal-error')).toContainText('exceeds');
      assert.equal((await snapshot()).records.find(record => record.id === primary.id).values[definition.finance.paid], primary.values[definition.finance.paid]);
      await payment.locator('[name=amount]').fill(String(due));
      await payment.locator('[name=method]').selectOption('bank');
      await payment.locator('button').click();
      await expect(page.locator('[role=dialog]')).toHaveCount(0);
      primary = (await snapshot()).records.find(record => record.id === primary.id);
      assert.equal(primary.values[definition.finance.paid], primary.values[definition.finance.total]);
      assert.ok((await snapshot()).payments.some(payment => payment.recordId === primary.id && payment.method === 'bank'));
      records.set(definition.key, primary);
      await openRecord(primary);
      await expect(page.locator('[data-form=payment]')).toHaveCount(0);
    }
  }
  if (definition.workflow && await page.locator('[data-form=status]').count()) {
    const next = await page.locator('[data-form=status] [name=status] option').first().getAttribute('value');
    await page.locator('[data-form=status] [name=status]').selectOption(next);
    await page.locator('[data-form=status] button').click();
    await expect(page.locator('[role=dialog]')).toHaveCount(0);
    assert.equal((await snapshot()).records.find(record => record.id === primary.id).values[definition.workflow.field], next);
  } else await page.locator('[data-action=close]').click();
  await navigate('reports');
  await capture('reports');
  const expectedRecords = (await snapshot()).records.length;
  const expectedPayments = (await snapshot()).payments.length;
  await application.close();
  await launch();
  await expect(page.locator('[data-form=login]')).toBeVisible();
  await login();
  assert.equal((await snapshot()).records.length, expectedRecords, 'Records survive restart');
  assert.equal((await snapshot()).payments.length, expectedPayments, 'Payments survive restart');

  const backupPath = path.join(directory, 'export-test.sqlite');
  await application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, backupPath);
  await navigate('settings');
  await page.locator('[data-action=backup]').first().click();
  await expect(page.locator('.global-message')).toContainText('Backup exported');
  assert.ok(existsSync(backupPath));
  await page.locator('[data-form=shop] [name=name]').fill('Changed after exporting backup');
  await page.locator('[data-form=shop] button').click();
  assert.equal((await snapshot()).shop.name, 'Changed after exporting backup');
  await page.locator('[data-action=restore]').click();
  await expect(page.locator('[data-form=login]')).toBeVisible();
  await login();
  const restored = await snapshot();
  assert.equal(restored.shop.name, `${config.name} Demo Business`);
  assert.equal(restored.records.length, expectedRecords);
  assert.equal(restored.payments.length, expectedPayments);
  assert.deepEqual(errors, [], 'No renderer JavaScript errors');
  console.log(`${config.name} desktop passed: empty setup, all ${config.entities.length} modules created through UI, references, calculations, images, search/filter, document preview, print cancellation, overpayment rejection, full bank collection, workflow, restart, backup/restore. Isolated data: ${directory}`);
})().catch(async error => {
  console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.resolve('test-results', 'failure.png') }).catch(() => {});
    console.error(await page.locator('.notice').allTextContents().catch(() => []));
  }
  process.exitCode = 1;
}).finally(async () => { if (application) await application.close().catch(() => {}); });
