// Web App API for Node backend. Paste at the bottom of the existing Apps Script project, then deploy a new Web App version.
// Secret source: CONFIG.WRITEBACK_SECRET or Script Property WRITEBACK_SECRET.
var WEBAPP_MAIN_SHEET = '\u5584\u6c34\u7528\u5730\u8b8a\u66f4\u5ba2\u6236\u56de\u5831\u7e3d\u8868';
var WEBAPP_SPREADSHEET_ID = '185NZwvJFPTsgi0H99mpl8KsDg_cMxxRbIwGu0N2Agko';

function getWritebackSpreadsheet_() {
  return SpreadsheetApp.openById(WEBAPP_SPREADSHEET_ID);
}

function getWebappMainSheetName_() {
  try {
    if (typeof CONFIG !== 'undefined' && CONFIG.SHEET_DATA) return CONFIG.SHEET_DATA;
  } catch (error) {}
  return WEBAPP_MAIN_SHEET;
}

function findWebappMainSheet_(ss) {
  var configured = ss.getSheetByName(getWebappMainSheetName_());
  if (configured) return configured;

  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var name = String(sheet.getName() || '');
    if (name.indexOf('總表') === -1 || sheet.getLastRow() < 1) continue;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(value) {
      return String(value || '').trim();
    });
    if (writebackFindColumnIndex_(headers, ['工廠登記編號', '廠編', '編號']) !== -1) return sheet;
  }

  for (var j = 0; j < sheets.length; j++) {
    var candidate = sheets[j];
    if (candidate.getLastRow() < 1) continue;
    var candidateHeaders = candidate.getRange(1, 1, 1, candidate.getLastColumn()).getValues()[0].map(function(value) {
      return String(value || '').trim();
    });
    var hasId = writebackFindColumnIndex_(candidateHeaders, ['工廠登記編號', '廠編', '編號']) !== -1;
    var hasRegion = writebackFindColumnIndex_(candidateHeaders, ['所屬區域', '區域']) !== -1;
    if (hasId && hasRegion) return candidate;
  }
  return null;
}
var WEBAPP_BACKUP_SHEET = 'WebAppDbBackup';
var WEBAPP_BACKUP_KEY = 'app-db-json';
var WEBAPP_CHUNK_SIZE = 40000;

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    var secret = getWritebackSecret_();
    if (secret && payload.secret !== secret) return writebackJson_({ ok: false, message: 'Invalid secret' });
    if (payload.action === 'saveDbBackup') return writebackJson_(saveDbBackup_(payload));
    if (payload.action === 'loadDbBackup') return writebackJson_(loadDbBackup_());
    if (payload.action === 'readCustomerSheet' || payload.action === 'writeCustomerSheet') {
      if (!secret) return writebackJson_({ ok: false, message: 'Writeback secret is required.' });
      var target = resolveCustomerSheet_(payload.target);
      if (payload.action === 'readCustomerSheet') {
        var values = target.sheet.getDataRange().getDisplayValues();
        var csv = values.map(function(row) {
          return row.map(function(cell) { return '"' + cell.replace(/"/g, '""') + '"'; }).join(',');
        }).join('\r\n');
        return writebackJson_({ ok: true, csv: csv });
      }
      return writebackJson_(writebackFactory_(payload.customer || {}, target));
    }
    return writebackJson_(writebackFactory_(payload));
  } catch (error) {
    return writebackJson_({ ok: false, message: error.message });
  }
}

function saveDbBackup_(payload) {
  if (!payload.db || typeof payload.db !== 'object') return { ok: false, message: 'Missing db backup payload' };
  var ss = getWritebackSpreadsheet_();
  var sheet = ss.getSheetByName(WEBAPP_BACKUP_SHEET) || ss.insertSheet(WEBAPP_BACKUP_SHEET);
  var json = JSON.stringify(payload.db);
  var rows = [];
  var updatedAt = payload.savedAt || new Date().toISOString();
  for (var i = 0; i < json.length; i += WEBAPP_CHUNK_SIZE) rows.push([WEBAPP_BACKUP_KEY, rows.length + 1, json.slice(i, i + WEBAPP_CHUNK_SIZE), updatedAt]);
  if (rows.length === 0) rows.push([WEBAPP_BACKUP_KEY, 1, '{}', updatedAt]);
  sheet.clear();
  sheet.getRange(1, 1, 1, 4).setValues([['key', 'chunk', 'json', 'updatedAt']]);
  sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  sheet.hideSheet();
  return { ok: true, savedAt: updatedAt, chunks: rows.length };
}

function loadDbBackup_() {
  var sheet = getWritebackSpreadsheet_().getSheetByName(WEBAPP_BACKUP_SHEET);
  if (!sheet) return { ok: true, exists: false, db: null };
  var values = sheet.getDataRange().getValues();
  var rows = values.slice(1).filter(function(row) { return row[0] === WEBAPP_BACKUP_KEY; }).sort(function(a, b) { return Number(a[1]) - Number(b[1]); });
  if (rows.length === 0) return { ok: true, exists: false, db: null };
  return { ok: true, exists: true, updatedAt: rows[0][3] || '', db: JSON.parse(rows.map(function(row) { return String(row[2] || ''); }).join('')) };
}

function resolveCustomerSheet_(target) {
  if (!target || !/^[\w-]+$/.test(target.spreadsheetId || '') || !/^\d+$/.test(target.gid || '')) {
    throw new Error('Invalid customer spreadsheet or tab ID.');
  }
  var ss = SpreadsheetApp.openById(target.spreadsheetId);
  var sheet = ss.getSheets().find(function(candidate) { return candidate.getSheetId() === Number(target.gid); });
  if (!sheet) throw new Error('Configured customer tab was not found.');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  if (headers.indexOf('\u5de5\u5ee0\u767b\u8a18\u7de8\u865f') === -1 ||
      headers.indexOf('\u516c\u53f8\u540d\u7a31') === -1 ||
      headers.indexOf('\u6240\u5c6c\u5340\u57df') === -1 ||
      headers.indexOf('\u62dc\u8a2a\u56de\u5831') === -1) {
    throw new Error('Configured customer tab is missing required headers.');
  }
  return { spreadsheet: ss, sheet: sheet, headers: headers };
}

function writebackFactory_(payload, target) {
  var factoryId = String(payload.factoryId || '').trim();
  if (!factoryId) return { ok: false, message: 'Missing factoryId' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, message: 'Google Sheet is busy. Please retry.' };
  try {
    return writebackFactoryLocked_(payload, target);
  } finally {
    lock.releaseLock();
  }
}

function writebackFactoryLocked_(payload, target) {
  var ss = target ? target.spreadsheet : getWritebackSpreadsheet_();
  var targetRegion = norm_(payload.region || '');
  var targetCompany = norm_(payload.sourceCompany || '');
  var regionSheet = findRegionSheet_(ss, targetRegion);
  var mainSheet = target ? target.sheet : findWebappMainSheet_(ss);
  if (!mainSheet) return { ok: false, message: 'Main sheet not found. Check the total sheet headers.' };
  var mainResult = prepareCustomerUpdate_(mainSheet, payload, targetRegion, targetCompany, target && target.headers);
  if (!mainResult.ok) return mainResult;
  var regionResult = regionSheet && regionSheet.getSheetId() !== mainSheet.getSheetId()
    ? prepareCustomerUpdate_(regionSheet, payload, targetRegion, targetCompany)
    : { ok: false, message: 'Region sheet not found' };
  try {
    applyCustomerUpdate_(mainSheet, mainResult);
    if (regionResult.ok) applyCustomerUpdate_(regionSheet, regionResult);
  } finally {
    SpreadsheetApp.flush();
  }
  return {
    ok: true,
    message: 'Google Sheet synced',
    regionSheet: regionSheet ? regionSheet.getName() : '',
    regionSheetOk: regionResult.ok,
    regionSheetMessage: regionResult.ok ? 'Region sheet synced' : regionResult.message,
    row: mainResult.row
  };
}

function prepareCustomerUpdate_(sheet, payload, targetRegion, targetCompany, knownHeaders) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, message: 'Sheet has no data: ' + sheet.getName() };
  var sourceHeaders = knownHeaders || sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var headers = sourceHeaders.map(function(value) { return value.trim(); });
  var idIdx = writebackFindColumnIndex_(headers, ['\u5de5\u5ee0\u767b\u8a18\u7de8\u865f', '\u5ee0\u7de8', '\u7de8\u865f']);
  var regionIdx = writebackFindColumnIndex_(headers, ['\u6240\u5c6c\u5340\u57df', '\u5340\u57df']);
  var companyIdx = writebackFindColumnIndex_(headers, ['\u516c\u53f8\u540d\u7a31', '\u5ee0\u540d', '\u516c\u53f8']);
  if (idIdx === -1) return { ok: false, message: 'Factory id column not found in ' + sheet.getName() };
  var data = sheet.getRange(1, 1, lastRow, Math.max(idIdx, regionIdx, companyIdx) + 1).getValues();
  var target = norm_(payload.factoryId || '');
  var matchRows = [];
  for (var i = 1; i < data.length; i++) {
    if (norm_(data[i][idIdx]) !== target) continue;
    matchRows.push(i + 1);
  }
  var row = resolveTargetRow_(sheet, headers, data, matchRows, regionIdx, companyIdx, targetRegion, targetCompany);
  if (!row) return { ok: false, message: 'Factory row not found in ' + sheet.getName() + ': ' + payload.factoryId };
  var update = { ok: true, row: row, headerStart: headers.length + 1, newHeaders: [], cells: {} };
  var fields = [
    ['company', ['\u516c\u53f8\u540d\u7a31', '\u5ee0\u540d', '\u516c\u53f8']],
    ['address', ['\u5de5\u5ee0\u5730\u5740', '\u5730\u5740', '\u5ee0\u5740']],
    ['owner', ['\u8ca0\u8cac\u4eba\u59d3\u540d', '\u8ca0\u8cac\u4eba', '\u806f\u7d61\u4eba']],
    ['phone', ['\u96fb\u8a71', '\u806f\u7d61\u96fb\u8a71', '\u624b\u6a5f']],
    ['grade', ['\u5ba2\u6236\u5206\u7d1a', '\u5206\u7d1a', '\u7b49\u7d1a']]
  ];
  fields.forEach(function(field) {
    var index = writebackFindColumnIndex_(headers, field[1]);
    if (index !== -1 && has_(payload, field[0])) update.cells[index + 1] = payload[field[0]] || '';
  });
  if (has_(payload, 'salesperson')) queueHeaderValue_(update, headers, '\u958b\u767c\u696d\u52d9', payload.salesperson);
  if (has_(payload, 'agencyType')) queueHeaderValue_(update, headers, '\u4ee3\u8fa6\u696d\u8005', payload.agencyType);
  if (has_(payload, 'status')) queueHeaderValue_(update, headers, '\u8ffd\u8e64\u72c0\u614b', statusLabel_(payload.status));
  if (has_(payload, 'nextDate')) queueHeaderValue_(update, headers, '\u4e0b\u6b21\u8ffd\u8e64\u65e5', payload.nextDate);
  queueHeaderValue_(update, headers, 'Web\u66f4\u65b0\u8005', payload.updatedBy);
  queueHeaderValue_(update, headers, 'Web\u66f4\u65b0\u6642\u9593', payload.updatedAt || new Date().toISOString());
  if (payload.note) queueVisitLog_(sheet, headers, update, payload);
  return update;
}

function findRegionSheet_(ss, targetRegion) {
  if (!targetRegion) return null;
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (norm_(name) === targetRegion) return sheets[i];
  }
  for (var j = 0; j < sheets.length; j++) {
    var sheetName = norm_(sheets[j].getName());
    if (sheetName.indexOf(targetRegion) !== -1 || targetRegion.indexOf(sheetName) !== -1) return sheets[j];
  }
  return null;
}

function resolveTargetRow_(sheet, headers, data, matchRows, regionIdx, companyIdx, targetRegion, targetCompany) {
  if (!matchRows.length) return 0;
  if (matchRows.length === 1) return matchRows[0];
  if (targetRegion && regionIdx !== -1) {
    for (var i = 0; i < matchRows.length; i++) {
      var regionValue = norm_(data[matchRows[i] - 1][regionIdx]);
      if (regionValue === targetRegion) return matchRows[i];
    }
  }
  if (targetCompany && companyIdx !== -1) {
    for (var j = 0; j < matchRows.length; j++) {
      var companyValue = norm_(data[matchRows[j] - 1][companyIdx]);
      if (companyValue === targetCompany) return matchRows[j];
    }
  }
  return 0;
}

function queueVisitLog_(sheet, headers, update, payload) {
  var col = writebackFindColumnIndex_(headers, ['\u62dc\u8a2a\u56de\u5831', '\u62dc\u8a2a\u7d00\u9304', '\u9032\u5ea6\u56de\u5831', '\u56de\u5831', '\u9032\u5ea6']);
  if (col === -1) return;
  var today = Utilities.formatDate(new Date(), 'GMT+8', 'MM/dd');
  var log = '[' + today + '] ' + payload.note + (payload.salesperson ? ' (' + payload.salesperson + ')' : '');
  var cell = sheet.getRange(update.row, col + 1);
  var oldLog = String(cell.getValue() || '');
  if (oldLog.indexOf(payload.note) !== -1) return;
  if (cell.getDataValidation()) update.clearValidation = cell;
  update.cells[col + 1] = oldLog ? log + '\n' + oldLog : log;
}

function queueHeaderValue_(update, headers, name, value) {
  var idx = headers.indexOf(name);
  if (idx === -1) {
    idx = headers.length;
    headers.push(name);
    update.newHeaders.push(name);
  }
  update.cells[idx + 1] = value || '';
}

function applyCustomerUpdate_(sheet, update) {
  if (update.newHeaders.length) {
    sheet.getRange(1, update.headerStart, 1, update.newHeaders.length).setValues([update.newHeaders]);
  }
  if (update.clearValidation) update.clearValidation.clearDataValidations();
  var columns = Object.keys(update.cells).map(Number).sort(function(a, b) { return a - b; });
  // Batch adjacent cells without rewriting untouched cells or formulas.
  for (var i = 0; i < columns.length;) {
    var start = columns[i];
    var values = [];
    while (i < columns.length && columns[i] === start + values.length) {
      values.push(update.cells[columns[i++]]);
    }
    sheet.getRange(update.row, start, 1, values.length).setValues([values]);
  }
}

function statusLabel_(status) {
  var labels = { todo: '\u5f85\u8655\u7406', follow: '\u8ffd\u8e64\u4e2d', visited: '\u5df2\u62dc\u8a2a', closed: '\u5df2\u7d50\u6848' };
  return labels[status] || '';
}

function writebackFindColumnIndex_(headers, possibleNames) {
  for (var i = 0; i < possibleNames.length; i++) {
    var index = headers.indexOf(possibleNames[i]);
    if (index !== -1) return index;
  }
  return -1;
}

function getWritebackSecret_() {
  if (typeof CONFIG !== 'undefined' && CONFIG.WRITEBACK_SECRET) return CONFIG.WRITEBACK_SECRET;
  return PropertiesService.getScriptProperties().getProperty('WRITEBACK_SECRET') || '';
}

function has_(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function norm_(value) {
  return String(value || '').trim().toUpperCase();
}

function writebackJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
