const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { makeFixture, testTarget } = require('./fixture-sheet');
const { createCustomerImporter, parseUpload } = require('../customer-import');

const secret = 'isolated-fixture-only';
const upload = (rows, region = '觀音區', createRegion = false) => ({
  name: 'fixture.csv', region, createRegion,
  content: Buffer.from('\ufeff所屬區域,工廠登記編號,公司名稱,電話\r\n' + rows).toString('base64')
});
const row = (factoryId, company, region = '觀音區') =>
  ({ factoryId, company, region, line: 2, issue: '', address: '', owner: '', phone: '' });

test('preview explains duplicates, cross-region conflicts and errors without mutating the workbook', async () => {
  const fixture = makeFixture(secret);
  const before = fixture.snapshot();
  const input = await parseUpload(upload('觀音區,0001,測試甲工廠,\r\n觀音區,0002,測試乙工廠,\r\n觀音區,0003,"新公司,股份",0012\r\n觀音區,0003,"新公司,股份",0012\r\n大園區,0004,區域不符公司,\r\n觀音區,,缺號,'));
  const result = fixture.call('previewCustomerImport', { input });
  assert.deepEqual(result.counts, { add: 1, existing: 2, review: 1, invalid: 2 });
  assert.deepEqual(result.rows.map(r => r.status), ['existing', 'review', 'add', 'existing', 'invalid', 'invalid']);
  assert.equal(input.rows[2].phone, '0012');
  assert.deepEqual(fixture.snapshot(), before);
});

test('same name with another ID, conflicting IDs in the file, and wrong targets are blocked', () => {
  const fixture = makeFixture(secret);
  const input = { region: '觀音區', rows: [row('0010', '測試甲工廠'), row('0011', '公司甲'), row('0011', '公司乙')] };
  assert.equal(fixture.call('previewCustomerImport', { input }).counts.review, 3);
  assert.equal(fixture.call('previewCustomerImport', { input, target: { ...testTarget, gid: '40' } }).ok, false);
  assert.equal(fixture.call('previewCustomerImport', { input }, 'wrong').ok, false);
});

test('commit appends to both tabs, preserves existing data, and retries cannot duplicate rows', async () => {
  const fixture = makeFixture(secret);
  const before = fixture.snapshot();
  const input = await parseUpload(upload('觀音區,0003,=SAMPLE(),0012'));
  const preview = fixture.call('previewCustomerImport', { input });
  const payload = { input, batchId: crypto.randomUUID(), fingerprint: preview.fingerprint };
  fixture.failNext();
  assert.equal(fixture.call('commitCustomerImport', payload).ok, false);
  assert.deepEqual(fixture.snapshot(), before);
  fixture.loseResponse();
  assert.equal(fixture.call('commitCustomerImport', payload).ok, false);
  const receipt = fixture.call('commitCustomerImport', payload);
  assert.equal(receipt.added, 1);
  assert.equal(fixture.batches(), 1);
  const snapshot = fixture.snapshot();
  for (const sheet of before) {
    const after = snapshot.find(candidate => candidate.id === sheet.id);
    assert.deepEqual(after.rows.slice(0, sheet.rows.length), sheet.rows);
    if (sheet.id === 10 || sheet.id === 20) {
      assert.equal(after.rows.length, sheet.rows.length + 1);
      assert.deepEqual(after.rows.at(-1), ['觀音區', '0003', '=SAMPLE()', '', '', '0012', '未分級', '', '未處理']);
    } else {
      assert.deepEqual(after, sheet);
    }
  }
});

test('creates only the explicitly selected new tab and rejects stale previews', async () => {
  const fixture = makeFixture(secret);
  const input = await parseUpload(upload('新屋區,0020,新區公司,', '新屋區', true));
  const preview = fixture.call('previewCustomerImport', { input });
  assert.equal(preview.createsRegion, true);
  assert.equal(fixture.call('commitCustomerImport', { input, batchId: crypto.randomUUID(), fingerprint: preview.fingerprint }).added, 1);
  assert.deepEqual(fixture.snapshot().at(-1).rows.map(r => r[1]), ['工廠登記編號', '0020']);
  const rejected = fixture.call('commitCustomerImport', { input, batchId: crypto.randomUUID(), fingerprint: preview.fingerprint });
  assert.equal(rejected.ok, false);
  assert.equal(fixture.batches(), 1);
  assert.equal(fixture.call('previewCustomerImport', { input: { ...input, region: '拜訪歷史紀錄' } }).ok, false);
});

test('preview ownership is checked; a successful receipt stays available across importer restarts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-import-test-'));
  const fixture = makeFixture(secret);
  const options = { dataDir, call: (...args) => fixture.call(...args) };
  const importer = createCustomerImporter(options);
  const user = { id: 'admin1', username: 'fixture-admin' };
  const preview = await importer.preview(upload('觀音區,0003,新客戶,'), user);
  assert.equal(preview.fingerprint, undefined);
  await assert.rejects(importer.commit(preview.batchId, { id: 'admin2' }), { httpStatus: 409 });
  const original = await importer.commit(preview.batchId, user);
  const restarted = createCustomerImporter(options);
  assert.deepEqual(await restarted.commit(preview.batchId, user), original);
  assert.deepEqual(await restarted.history(), [original]);
  assert.equal(fixture.batches(), 1);
});

test('invalid uploads and more than 500 rows are refused', async () => {
  await assert.rejects(parseUpload({ ...upload('0003,壞資料'), name: 'data.xls' }), { httpStatus: 400 });
  await assert.rejects(parseUpload({ ...upload(''), name: 'fake.xlsx' }), { httpStatus: 400 });
  await assert.rejects(parseUpload(upload(Array(501).fill('觀音區,0003,公司,').join('\n'))), { httpStatus: 413 });
});

test('Excel preserves text zeros and warns about numeric registration IDs', async () => {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const links = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const inline = (cell, value) => `<c r="${cell}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const grid = `<worksheet xmlns="${ns}"><sheetData><row r="1">${inline('A1', '工廠登記編號')}${inline('B1', '公司名稱')}</row>
    <row r="2">${inline('A2', '0007')}${inline('B2', '試算表測試')}</row>
    <row r="3"><c r="A3"><v>8</v></c>${inline('B3', '數字編號')}</row></sheetData></worksheet>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${links}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${links}"><sheets><sheet name="第一頁" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${links}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': grid
  };
  const content = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))).toString('base64');
  const input = await parseUpload({ name: 'test.xlsx', region: '觀音區', content });
  assert.equal(input.rows[0].factoryId, '0007');
  assert.equal(input.rows[0].issue, '');
  assert.match(input.rows[1].issue, /登記編號須為文字/);
});
