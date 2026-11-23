const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const { readSheet } = require('read-excel-file/node');
const zip = require('yauzl');

const maxBytes = 512 * 1024;
const maxRows = 500;
const ttl = 30 * 60 * 1000;
const columns = {
  factoryId: ['工廠登記編號', '廠編', '編號'],
  company: ['公司名稱', '廠名', '公司'],
  region: ['所屬區域', '區域'],
  address: ['工廠地址', '地址', '廠址'],
  owner: ['負責人姓名', '負責人', '聯絡人'],
  phone: ['電話', '聯絡電話', '手機']
};
const text = value => String(value ?? '').trim();
const error = (httpStatus, message) => Object.assign(new Error(message), { httpStatus, code: 'CUSTOMER_IMPORT' });

function inspectArchive(buffer) {
  return new Promise((resolve, reject) => {
    zip.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (reason, archive) => {
      if (reason) return reject(reason);
      let entries = 0, expanded = 0;
      const limit = 8 * 1024 * 1024;
      function fail(reason) { archive.close(); reject(reason); }
      archive.on('error', fail);
      archive.on('end', resolve);
      archive.on('entry', entry => {
        if (++entries > 100 || expanded + entry.uncompressedSize > limit) return fail(new Error('Archive limits'));
        archive.openReadStream(entry, (reason, stream) => {
          if (reason) return fail(reason);
          stream.on('error', fail);
          stream.on('data', chunk => {
            expanded += chunk.length;
            if (expanded > limit) stream.destroy(new Error('Archive limits'));
          });
          stream.on('end', () => archive.readEntry());
        });
      });
      archive.readEntry();
    });
  });
}

async function parseUpload(body) {
  const ext = path.extname(text(body.name)).toLowerCase();
  if (!['.csv', '.xlsx'].includes(ext)) throw error(400, '請上傳 CSV 或 Excel（.xlsx）檔案。');
  if (typeof body.content !== 'string' || !body.content) throw error(400, '尚未選擇名單檔案。');
  if (body.content.length > Math.ceil(maxBytes / 3) * 4) throw error(413, '檔案不可超過 512 KB。');
  const buffer = Buffer.from(body.content, 'base64');
  if (!buffer.length || buffer.length > maxBytes || buffer.toString('base64') !== body.content) {
    throw error(400, '無法讀取上傳的檔案。');
  }
  let grid;
  try {
    if (ext === '.csv') {
      grid = parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer), {
        bom: true, max_record_size: 12000, relax_column_count: true, record_delimiter: ['\r\n', '\n', '\r']
      });
    } else {
      await inspectArchive(buffer);
      grid = await readSheet(buffer);
    }
  } catch {
    throw error(400, '無法讀取檔案：請使用 UTF-8 CSV 或有效的 .xlsx，資料放在第一個分頁。');
  }
  const region = text(body.region).normalize('NFKC');
  if (!region || region.length > 40 || !/^[\p{Script=Han}A-Za-z0-9 ()-]+$/u.test(region)) {
    throw error(400, '請選擇區域或輸入有效的區域名稱。');
  }
  const headers = (grid[0] || []).map(text);
  const indexes = {};
  for (const [key, aliases] of Object.entries(columns)) {
    const matches = headers.flatMap((h, index) => aliases.includes(h) ? [index] : []);
    if (matches.length > 1) throw error(400, `欄位「${aliases[0]}」重複，請保留一欄。`);
    indexes[key] = matches[0] ?? -1;
  }
  if (indexes.factoryId < 0 || indexes.company < 0) throw error(400, '第一列需有「工廠登記編號」及「公司名稱」。');

  const rows = [];
  for (let index = 1; index < grid.length; index++) {
    const row = grid[index];
    if (!row.some(cell => text(cell))) continue;
    if (rows.length >= maxRows) throw error(413, '每批最多 500 筆，請分批匯入。');
    const values = Object.fromEntries(Object.entries(indexes).map(([key, col]) => [key, text(row[col])]));
    let issue = '';
    if (row.slice(headers.length).some(text)) issue = '資料欄位超出表頭，請檢查分隔符號。';
    else if (typeof row[indexes.factoryId] === 'number') issue = '登記編號須為文字，請確認前導零未遺失。';
    else if (!values.factoryId || !values.company) issue = '缺少登記編號或公司名稱。';
    else if (values.region && values.region.normalize('NFKC') !== region) issue = '檔案區域與選取的區域不同。';
    else if (values.factoryId.length > 50 || values.company.length > 180 || values.address.length > 300 ||
      values.owner.length > 100 || values.phone.length > 100 || Object.values(values).some(value => /[\r\n\t\x00]/.test(value))) {
      issue = '欄位過長或含有無效字元。';
    }
    rows.push({ ...values, line: index + 1, issue });
  }
  if (!rows.length) throw error(400, '檔案沒有可預覽的資料列。');
  return { region, createRegion: body.createRegion === true, rows };
}

function createCustomerImporter({ dataDir, call }) {
  const drafts = new Map();
  let inflight = 0;
  const directory = path.join(dataDir, 'customer-imports');
  const receiptPath = id => path.join(directory, id + '.json');
  const readReceipt = async id => {
    try { return JSON.parse(await fs.readFile(receiptPath(id), 'utf8')); }
    catch (reason) { if (reason.code !== 'ENOENT') throw reason; return null; }
  };
  async function preview(body, user) {
    for (const [id, draft] of drafts) if (draft.expires <= Date.now() && !draft.running) drafts.delete(id);
    if (inflight >= 2 || drafts.size + inflight >= 24) throw error(429, '預覽批次已滿，請稍後再試。');
    inflight++;
    let input, result;
    try {
      input = await parseUpload(body);
      result = await call('previewCustomerImport', { input });
    } finally { inflight--; }
    if (!result?.ok || !Array.isArray(result.rows) || typeof result.fingerprint !== 'string') {
      throw error(409, result?.message || '無法預覽，請確認匯入端點設定。');
    }
    const batchId = crypto.randomUUID();
    if (result.counts.add > 0) drafts.set(batchId, { input, result, userId: user.id, expires: Date.now() + ttl });
    const { fingerprint, ...view } = result;
    return { batchId, ...view };
  }
  async function commit(batchId, user) {
    if (typeof batchId !== 'string' || !/^[a-f0-9-]{36}$/.test(batchId)) throw error(400, '缺少有效的批次編號。');
    const saved = await readReceipt(batchId);
    if (saved) {
      if (saved.userId !== user.id) throw error(404, '找不到這個批次。');
      return saved;
    }
    const draft = drafts.get(batchId);
    if (!draft || draft.userId !== user.id || draft.expires <= Date.now()) throw error(409, '預覽已失效，請重新上傳並預覽。');
    if (draft.running) return draft.running;
    draft.running = (async () => {
      await fs.mkdir(directory, { recursive: true });
      const result = await call('commitCustomerImport', { input: draft.input, batchId, fingerprint: draft.result.fingerprint });
      if (!result?.ok || result.added !== draft.result.counts.add) throw error(409, result?.message || '尚未確認匯入結果，請重試同一批次。');
      const receipt = {
        batchId, userId: user.id, operator: user.username, at: result.at,
        region: draft.input.region, regionSheet: draft.result.regionSheet,
        counts: draft.result.counts, added: result.added
      };
      const temp = receiptPath(batchId) + '.tmp';
      await fs.writeFile(temp, JSON.stringify(receipt), { mode: 0o600 });
      await fs.rename(temp, receiptPath(batchId));
      drafts.delete(batchId);
      return receipt;
    })();
    try { return await draft.running; }
    finally { draft.running = null; }
  }
  async function history() {
    let names;
    try { names = await fs.readdir(directory); }
    catch (reason) { if (reason.code !== 'ENOENT') throw reason; return []; }
    const receipts = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readReceipt(name.slice(0, -5))));
    return receipts.filter(Boolean).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  }
  return { preview, commit, history };
}

module.exports = { createCustomerImporter, parseUpload, maxBytes };
