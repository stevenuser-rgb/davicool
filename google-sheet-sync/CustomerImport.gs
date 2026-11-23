var CUSTOMER_IMPORT_COLUMNS = {
  region: ['所屬區域', '區域'],
  factoryId: ['工廠登記編號', '廠編', '編號'],
  company: ['公司名稱', '廠名', '公司'],
  address: ['工廠地址', '地址', '廠址'],
  owner: ['負責人姓名', '負責人', '聯絡人'],
  phone: ['電話', '聯絡電話', '手機'],
  grade: ['客戶分級', '分級', '等級'],
  feedback: ['拜訪回報', '拜訪紀錄', '進度回報', '回報', '進度'],
  status: ['追蹤狀態']
};
var CUSTOMER_IMPORT_NEW_HEADERS = Object.keys(CUSTOMER_IMPORT_COLUMNS).map(function(key) {
  return CUSTOMER_IMPORT_COLUMNS[key][0];
});
var CUSTOMER_IMPORT_METADATA = 'crm_customer_import_v1';

function customerImportKey_(value) {
  return String(value == null ? '' : value).trim().normalize('NFKC').toUpperCase();
}

function customerImportColumns_(headers, isMain) {
  var indexes = {};
  Object.keys(CUSTOMER_IMPORT_COLUMNS).forEach(function(key) {
    var matches = [];
    headers.forEach(function(value, index) {
      if (CUSTOMER_IMPORT_COLUMNS[key].indexOf(String(value).trim()) !== -1) matches.push(index);
    });
    if (matches.length > 1) throw new Error('目標分頁有重複欄位：' + CUSTOMER_IMPORT_COLUMNS[key][0]);
    indexes[key] = matches.length ? matches[0] : -1;
  });
  if (indexes.factoryId < 0 || indexes.company < 0 || indexes.feedback < 0 || (isMain && indexes.region < 0)) {
    throw new Error('目標分頁缺少工廠登記編號、公司名稱、拜訪回報或總表的所屬區域。');
  }
  return indexes;
}

function customerImportTarget_(target, input) {
  var mainId = target.sheet.getSheetId();
  var region = customerImportKey_(input.region);
  var sheets = target.spreadsheet.getSheets();
  var exact = sheets.filter(function(sheet) { return customerImportKey_(sheet.getName()) === region; });
  var aliases = sheets.filter(function(sheet) {
    var name = customerImportKey_(sheet.getName());
    return sheet.getSheetId() !== mainId &&
      /(?:客戶名單|特登名單|客戶|特登|名單)$/.test(name) &&
      name.replace(/(?:客戶名單|特登名單|客戶|特登|名單)$/, '') === region;
  });
  var matches = exact.length ? exact : aliases;
  if (matches.length > 1 || matches.some(function(sheet) { return sheet.getSheetId() === mainId; })) {
    throw new Error('區域分頁辨識不唯一，請確認分頁名稱。');
  }
  if (matches.length && input.createRegion) throw new Error('此區域分頁已存在，請改選既有區域。');
  if (!matches.length && !input.createRegion) throw new Error('找不到區域分頁，請檢查名稱或明確選擇新增區域。');
  if (/(總表|紀錄|統計|備份|設定|管理)|WEBAPPDBBACKUP/i.test(region)) throw new Error('這個名稱不能作為區域分頁。');
  return matches[0] || null;
}

function customerImportSnapshot_(sheet, headers, isMain) {
  var indexes = customerImportColumns_(headers, isMain);
  var lastRow = sheet ? sheet.getLastRow() : 0;
  var maxIndex = Math.max(indexes.factoryId, indexes.company, indexes.region);
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, maxIndex + 1).getDisplayValues() : [];
  return { sheet: sheet, indexes: indexes, width: headers.length, headers: headers, rows: rows };
}

function customerImportFindings_(data, region) {
  var ids = Object.create(null);
  var companies = Object.create(null);
  data.rows.forEach(function(row) {
    var id = customerImportKey_(row[data.indexes.factoryId]);
    var company = customerImportKey_(row[data.indexes.company]);
    var rowRegion = data.indexes.region === -1 ? region : customerImportKey_(row[data.indexes.region]);
    if (id) (ids[id] || (ids[id] = [])).push({ company: company, region: rowRegion });
    if (company) (companies[company] || (companies[company] = [])).push({ id: id });
  });
  return { ids: ids, companies: companies };
}

function customerImportNewRow_(snapshot, row, region) {
  var values = Object.assign({}, row, { region: region, grade: '未分級', status: '未處理', feedback: '' });
  var cells = Array.from({ length: snapshot.width }, function() { return {}; });
  Object.keys(CUSTOMER_IMPORT_COLUMNS).forEach(function(key) {
    var index = snapshot.indexes[key];
    // A typed string preserves leading zeros and never evaluates uploaded text as a formula.
    if (index >= 0 && values[key]) cells[index] = { userEnteredValue: { stringValue: values[key] } };
  });
  return { values: cells };
}

function customerImportPlan_(target, input) {
  if (!input || typeof input.region !== 'string' || input.region.length > 40 ||
    !/^[\p{Script=Han}A-Za-z0-9 ()-]+$/u.test(input.region) ||
    !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 500) {
    throw new Error('匯入批次格式不正確。');
  }
  var regionTab = customerImportTarget_(target, input);
  var regionName = customerImportKey_(input.region);
  var main = customerImportSnapshot_(target.sheet, target.headers, true);
  if (regionTab && !main.rows.some(function(row) {
    return customerImportKey_(row[main.indexes.region]) === regionName && customerImportKey_(row[main.indexes.factoryId]);
  })) throw new Error('總表未登記此區域，請先確認分頁用途。');
  var region = customerImportSnapshot_(regionTab, regionTab
    ? regionTab.getRange(1, 1, 1, Math.max(1, regionTab.getLastColumn())).getDisplayValues()[0]
    : CUSTOMER_IMPORT_NEW_HEADERS, false);
  var mainIndex = customerImportFindings_(main, regionName);
  var regionIndex = customerImportFindings_(region, regionName);
  var inputIndex = customerImportFindings_({
    indexes: { factoryId: 0, company: 1, region: -1 },
    rows: input.rows.filter(function(row) { return !row.issue; }).map(function(row) { return [row.factoryId, row.company]; })
  }, regionName);
  var seen = Object.create(null);
  var counts = { add: 0, existing: 0, review: 0, invalid: 0 };
  var additions = [];
  var rows = input.rows.map(function(row) {
    var id = customerImportKey_(row.factoryId);
    var company = customerImportKey_(row.company);
    var mainMatches = mainIndex.ids[id] || [];
    var regionMatches = regionIndex.ids[id] || [];
    var matches = mainMatches.concat(regionMatches);
    var sameCompany = (mainIndex.companies[company] || []).concat(regionIndex.companies[company] || [], inputIndex.companies[company] || []);
    var sameId = inputIndex.ids[id] || [];
    var status = 'add', message = '';
    if (row.issue || !id || !company || (row.region && customerImportKey_(row.region) !== regionName)) {
      status = 'invalid'; message = row.issue || '必填欄位缺少或區域不符。';
    } else if (sameId.some(function(hit) { return hit.company !== company; }) ||
      matches.some(function(hit) { return hit.company !== company || hit.region !== regionName; }) ||
      sameCompany.some(function(hit) { return hit.id !== id; }) || mainMatches.length > 1 || regionMatches.length > 1) {
      status = 'review'; message = '廠編、公司名稱或區域有衝突，請人工核對。';
    } else if (mainMatches.length && regionMatches.length) {
      status = 'existing'; message = '總表和區域分頁已有此公司。';
    } else if (matches.length) {
      status = 'review'; message = '只有一張既有分頁有這筆資料，不自動補寫。';
    } else if (seen[id]) {
      status = 'existing'; message = '與檔案前一筆重複。';
    } else {
      var missing = ['address', 'owner', 'phone'].filter(function(key) {
        return row[key] && (main.indexes[key] < 0 || region.indexes[key] < 0);
      });
      if (missing.length) {
        status = 'invalid';
        message = '目標分頁缺少欄位：' + missing.map(function(key) { return CUSTOMER_IMPORT_COLUMNS[key][0]; }).join('、');
      }
    }
    counts[status]++;
    if (status === 'add') {
      seen[id] = true;
      additions.push(row);
    }
    return { line: row.line, factoryId: row.factoryId, company: row.company, status: status, message: message };
  });
  var regionSheet = regionTab ? regionTab.getName() : input.region;
  var fingerprint = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify([target.sheet.getSheetId(), regionTab ? regionTab.getSheetId() : null,
      main.headers, region.headers, input, rows]), Utilities.Charset.UTF_8));
  return { main: main, region: region, additions: additions, view: {
    ok: true, regionSheet: regionSheet, createsRegion: !regionTab, counts: counts, rows: rows, fingerprint: fingerprint
  } };
}

function customerImportDispatch_(action, target, payload) {
  if (action === 'previewCustomerImport') return customerImportPlan_(target, payload.input).view;
  if (action !== 'commitCustomerImport' || !/^[a-f0-9-]{36}$/.test(payload.batchId || '')) {
    throw new Error('匯入批次無效。');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('目前正在處理其他更新，請重試同一批次。');
  try {
    var spreadsheetId = target.spreadsheet.getId();
    var result = Sheets.Spreadsheets.DeveloperMetadata.search({ dataFilters: [{ developerMetadataLookup: {
      metadataKey: CUSTOMER_IMPORT_METADATA + ':' + payload.batchId, visibility: 'DOCUMENT'
    } }] }, spreadsheetId);
    var previous = (result.matchedDeveloperMetadata || [])[0];
    if (previous) {
      var receipt = JSON.parse(previous.developerMetadata.metadataValue);
      if (receipt.fingerprint !== payload.fingerprint) throw new Error('批次內容與既有結果不同。');
      return { ok: true, added: receipt.added, at: receipt.at };
    }
    // Resolve headers again inside the same lock used by visit writeback.
    target = resolveCustomerSheet_(payload.target);
    var plan = customerImportPlan_(target, payload.input);
    if (!plan.additions.length || plan.view.fingerprint !== payload.fingerprint) {
      throw new Error('預覽後名單或分頁已變更，請重新預覽。');
    }
    var requests = [];
    var mainId = plan.main.sheet.getSheetId();
    var regionId;
    if (plan.region.sheet) {
      regionId = plan.region.sheet.getSheetId();
    } else {
      var used = target.spreadsheet.getSheets().map(function(sheet) { return sheet.getSheetId(); });
      do { regionId = Math.floor(Math.random() * 2000000000) + 1; } while (used.indexOf(regionId) !== -1);
      requests.push({ addSheet: { properties: {
        sheetId: regionId, title: plan.view.regionSheet,
        gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 }
      } } });
    }
    var regionRows = plan.additions.map(function(row) { return customerImportNewRow_(plan.region, row, payload.input.region); });
    if (!plan.region.sheet) regionRows.unshift({
      values: CUSTOMER_IMPORT_NEW_HEADERS.map(function(header) { return { userEnteredValue: { stringValue: header } }; })
    });
    requests.push(
      { appendCells: { sheetId: mainId, rows: plan.additions.map(function(row) {
        return customerImportNewRow_(plan.main, row, payload.input.region);
      }), fields: 'userEnteredValue' } },
      { appendCells: { sheetId: regionId, rows: regionRows, fields: 'userEnteredValue' } }
    );
    var receipt = { added: plan.additions.length, at: new Date().toISOString(), fingerprint: plan.view.fingerprint };
    requests.push({ createDeveloperMetadata: { developerMetadata: {
      metadataKey: CUSTOMER_IMPORT_METADATA + ':' + payload.batchId,
      metadataValue: JSON.stringify(receipt), location: { spreadsheet: true }, visibility: 'DOCUMENT'
    } } });
    // No update, clear, or delete request is allowed here; both appends apply atomically.
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheetId);
    return { ok: true, added: receipt.added, at: receipt.at };
  } finally {
    lock.releaseLock();
  }
}
