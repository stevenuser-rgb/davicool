const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const testTarget = { spreadsheetId: 'LOCAL_FIXTURE', gid: '10' };
const headers = ['所屬區域', '工廠登記編號', '公司名稱', '工廠地址', '負責人姓名', '電話', '客戶分級', '拜訪回報', '追蹤狀態'];
function makeFixture(secret) {
  let sheets = [
    { id: 10, name: '客戶總表', rows: [headers, ['觀音區', '0001', '測試甲工廠', '示例路一號', '', '', 'A', '既有拜訪', '待追蹤'], ['大園區', '0002', '測試乙工廠', '', '', '', 'D']] },
    { id: 20, name: '觀音區', rows: [headers, ['觀音區', '0001', '測試甲工廠', '', '', '', 'A', '區域既有拜訪', '待追蹤']] },
    { id: 30, name: '大園區', rows: [headers, ['大園區', '0002', '測試乙工廠', '', '', '', 'D']] },
    { id: 40, name: '統計表', rows: [['不得變更'], ['統計公式測試']] }
  ];
  let metadata = [];
  let batches = 0;
  let failNext = false;
  let loseResponse = false;
  const config = {
    WRITEBACK_SECRET: secret,
    CUSTOMER_IMPORT_SPREADSHEET_ID: testTarget.spreadsheetId,
    CUSTOMER_IMPORT_GID: testTarget.gid
  };
  const sheetObject = item => ({
    getName: () => item.name,
    getSheetId: () => item.id,
    getLastColumn: () => Math.max(...item.rows.map(row => row.length)),
    getLastRow: () => item.rows.length,
    getDataRange: () => ({ getDisplayValues: () => item.rows.map(row => row.map(String)) }),
    getRange: (r, c, height, width) => ({
      getDisplayValues: () => Array.from({ length: height }, (_, index) =>
        Array.from({ length: width }, (_, col) => String(item.rows[r - 1 + index]?.[c - 1 + col] ?? '')))
    })
  });
  const book = {
    getId: () => testTarget.spreadsheetId,
    getSheets: () => sheets.map(sheetObject)
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: id => {
      if (id !== testTarget.spreadsheetId) throw Error('Wrong test workbook');
      return book;
    } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => config[key] || '' }) },
    ContentService: { createTextOutput: value => ({ setMimeType: () => value }), MimeType: { JSON: 'json' } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => crypto.createHash(algorithm).update(value).digest(),
      base64EncodeWebSafe: buffer => Buffer.from(buffer).toString('base64url')
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Sheets: { Spreadsheets: {
      DeveloperMetadata: { search: (query, id) => {
        if (id !== testTarget.spreadsheetId) throw Error('Wrong test metadata workbook');
        const key = query.dataFilters[0].developerMetadataLookup.metadataKey;
        return { matchedDeveloperMetadata: metadata.filter(m => m.metadataKey === key).map(m => ({ developerMetadata: m })) };
      } },
      batchUpdate: ({ requests }, id) => {
        if (failNext) { failNext = false; throw Error('Simulated rejection before any write'); }
        if (id !== testTarget.spreadsheetId) throw Error('Wrong test write workbook');
        const next = structuredClone(sheets);
        const nextMeta = structuredClone(metadata);
        for (const request of requests) {
          if (request.addSheet) {
            const { sheetId, title } = request.addSheet.properties;
            if (next.some(s => s.id === sheetId || s.name === title)) throw Error('Duplicate sheet');
            next.push({ id: sheetId, name: title, rows: [] });
          } else if (request.appendCells) {
            const { sheetId, rows, fields } = request.appendCells;
            if (fields !== 'userEnteredValue') throw Error('Unexpected update fields');
            next.find(s => s.id === sheetId).rows.push(...rows.map(row => Array.from(row.values, cell => {
              const value = cell.userEnteredValue;
              if (value && typeof value.stringValue !== 'string') throw Error('Expected literal text');
              return value?.stringValue ?? '';
            })));
          } else if (request.createDeveloperMetadata) {
            nextMeta.push(request.createDeveloperMetadata.developerMetadata);
          } else {
            throw Error('Non-append request rejected by fixture');
          }
        }
        sheets = next;
        metadata = nextMeta;
        batches++;
        if (loseResponse) { loseResponse = false; throw Error('Simulated lost response after commit'); }
      }
    } }
  });
  for (const name of ['AppendToExisting.gs', 'CustomerImport.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'google-sheet-sync', name), 'utf8'), context, { filename: name });
  }
  return {
    snapshot: () => structuredClone(sheets),
    batches: () => batches,
    failNext: () => { failNext = true; },
    loseResponse: () => { loseResponse = true; },
    call: (action, payload = {}, key = secret) => JSON.parse(context.doPost({
      postData: { contents: JSON.stringify({ secret: key, target: testTarget, action, ...payload }) }
    }))
  };
}

module.exports = { makeFixture, testTarget };
