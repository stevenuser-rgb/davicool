// Web App API for Node backend. Paste at the bottom of the existing Apps Script project, then deploy a new Web App version.
// Secret source: CONFIG.WRITEBACK_SECRET or Script Property WRITEBACK_SECRET.
var WEBAPP_MAIN_SHEET = '\u5584\u6c34\u7528\u5730\u8b8a\u66f4\u5ba2\u6236\u56de\u5831\u7e3d\u8868';

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
    if (findColumnIndex(headers, ['工廠登記編號', '廠編', '編號']) !== -1) return sheet;
  }

  for (var j = 0; j < sheets.length; j++) {
    var candidate = sheets[j];
    if (candidate.getLastRow() < 1) continue;
    var candidateHeaders = candidate.getRange(1, 1, 1, candidate.getLastColumn()).getValues()[0].map(function(value) {
      return String(value || '').trim();
    });
    var hasId = findColumnIndex(candidateHeaders, ['工廠登記編號', '廠編', '編號']) !== -1;
    var hasRegion = findColumnIndex(candidateHeaders, ['所屬區域', '區域']) !== -1;
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
    return writebackJson_(writebackFactory_(payload));
  } catch (error) {
    return writebackJson_({ ok: false, message: error.message });
  }
}

function saveDbBackup_(payload) {
  if (!payload.db || typeof payload.db !== 'object') return { ok: false, message: 'Missing db backup payload' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
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
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WEBAPP_BACKUP_SHEET);
  if (!sheet) return { ok: true, exists: false, db: null };
  var values = sheet.getDataRange().getValues();
  var rows = values.slice(1).filter(function(row) { return row[0] === WEBAPP_BACKUP_KEY; }).sort(function(a, b) { return Number(a[1]) - Number(b[1]); });
  if (rows.length === 0) return { ok: true, exists: false, db: null };
  return { ok: true, exists: true, updatedAt: rows[0][3] || '', db: JSON.parse(rows.map(function(row) { return String(row[2] || ''); }).join('')) };
}

function writebackFactory_(payload) {
  var factoryId = String(payload.factoryId || '').trim();
  if (!factoryId) return { ok: false, message: 'Missing factoryId' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var targetRegion = norm_(payload.region || '');
  var targetCompany = norm_(payload.sourceCompany || '');
  var regionSheet = findRegionSheet_(ss, targetRegion);
  var regionResult = regionSheet ? writeCustomerStateToSheet_(regionSheet, payload, targetRegion, targetCompany, true) : { ok: false, message: 'Region sheet not found' };
  var mainSheet = findWebappMainSheet_(ss);
  if (!mainSheet) return { ok: false, message: 'Main sheet not found. Check the total sheet headers.' };
  var mainResult = writeCustomerStateToSheet_(mainSheet, payload, targetRegion, targetCompany, false);
  if (!mainResult.ok) return mainResult;
  return {
    ok: true,
    message: 'Google Sheet synced',
    regionSheet: regionSheet ? regionSheet.getName() : '',
    regionSheetOk: !!regionSheet,
    regionSheetMessage: regionResult.message || '',
    row: mainResult.row
  };
}

function writeCustomerStateToSheet_(sheet, payload, targetRegion, targetCompany, isRegionSheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: false, message: 'Sheet has no data: ' + sheet.getName() };
  var headers = data[0].map(function(value) { return String(value || '').trim(); });
  var idIdx = findColumnIndex(headers, ['\u5de5\u5ee0\u767b\u8a18\u7de8\u865f', '\u5ee0\u7de8', '\u7de8\u865f']);
  var regionIdx = findColumnIndex(headers, ['\u6240\u5c6c\u5340\u57df', '\u5340\u57df']);
  var companyIdx = findColumnIndex(headers, ['\u516c\u53f8\u540d\u7a31', '\u5ee0\u540d', '\u516c\u53f8']);
  if (idIdx === -1) return { ok: false, message: 'Factory id column not found in ' + sheet.getName() };
  var target = norm_(payload.factoryId || '');
  var matchRows = [];
  for (var i = 1; i < data.length; i++) {
    if (norm_(data[i][idIdx]) !== target) continue;
    matchRows.push(i + 1);
  }
  var row = resolveTargetRow_(sheet, headers, data, matchRows, regionIdx, companyIdx, targetRegion, targetCompany);
  if (!row) return { ok: false, message: 'Factory row not found in ' + sheet.getName() + ': ' + payload.factoryId };
  setIfPresent_(sheet, row, headers, ['\u516c\u53f8\u540d\u7a31', '\u5ee0\u540d', '\u516c\u53f8'], payload, 'company');
  setIfPresent_(sheet, row, headers, ['\u5de5\u5ee0\u5730\u5740', '\u5730\u5740', '\u5ee0\u5740'], payload, 'address');
  setIfPresent_(sheet, row, headers, ['\u8ca0\u8cac\u4eba\u59d3\u540d', '\u8ca0\u8cac\u4eba', '\u806f\u7d61\u4eba'], payload, 'owner');
  setIfPresent_(sheet, row, headers, ['\u96fb\u8a71', '\u806f\u7d61\u96fb\u8a71', '\u624b\u6a5f'], payload, 'phone');
  setIfPresent_(sheet, row, headers, ['\u5ba2\u6236\u5206\u7d1a', '\u5206\u7d1a', '\u7b49\u7d1a'], payload, 'grade');
  setHeaderValue_(sheet, headers, row, '\u958b\u767c\u696d\u52d9', payload.salesperson || '');
  setHeaderValue_(sheet, headers, row, '\u4ee3\u8fa6\u696d\u8005', payload.agencyType || '');
  setHeaderValue_(sheet, headers, row, '\u8ffd\u8e64\u72c0\u614b', statusLabel_(payload.status || ''));
  if (has_(payload, 'nextDate')) setHeaderValue_(sheet, headers, row, '\u4e0b\u6b21\u8ffd\u8e64\u65e5', payload.nextDate || '');
  setHeaderValue_(sheet, headers, row, 'Web\u66f4\u65b0\u8005', payload.updatedBy || '');
  setHeaderValue_(sheet, headers, row, 'Web\u66f4\u65b0\u6642\u9593', payload.updatedAt || new Date().toISOString());
  removeVisitLogDropdown_(sheet, headers);
  if (payload.note) appendLog_(sheet, headers, row, payload);
  return { ok: true, message: (isRegionSheet ? 'Region sheet synced' : 'Main sheet synced'), row: row };
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

function appendLog_(sheet, headers, row, payload) {
  var col = findColumnIndex(headers, ['\u62dc\u8a2a\u56de\u5831', '\u62dc\u8a2a\u7d00\u9304', '\u9032\u5ea6\u56de\u5831', '\u56de\u5831', '\u9032\u5ea6']);
  if (col === -1) return;
  var today = Utilities.formatDate(new Date(), 'GMT+8', 'MM/dd');
  var log = '[' + today + '] ' + payload.note + (payload.salesperson ? ' (' + payload.salesperson + ')' : '');
  var cell = sheet.getRange(row, col + 1);
  var oldLog = String(cell.getValue() || '');
  if (oldLog.indexOf(payload.note) === -1) cell.setValue(oldLog ? log + '\n' + oldLog : log);
}

function removeVisitLogDropdown_(sheet, headers) {
  var col = findColumnIndex(headers, ['\u62dc\u8a2a\u56de\u5831', '\u62dc\u8a2a\u7d00\u9304', '\u9032\u5ea6\u56de\u5831', '\u56de\u5831', '\u9032\u5ea6']);
  if (col === -1) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  sheet.getRange(2, col + 1, lastRow - 1, 1).clearDataValidations();
}

function setIfPresent_(sheet, row, headers, names, payload, key) {
  if (!has_(payload, key)) return;
  var idx = findColumnIndex(headers, names);
  if (idx !== -1) sheet.getRange(row, idx + 1).setValue(payload[key] || '');
}

function setHeaderValue_(sheet, headers, row, name, value) {
  var idx = headers.indexOf(name);
  if (idx === -1) {
    idx = headers.length;
    headers.push(name);
    sheet.getRange(1, idx + 1).setValue(name);
  }
  sheet.getRange(row, idx + 1).setValue(value || '');
}

function statusLabel_(status) {
  var labels = { todo: '\u5f85\u8655\u7406', follow: '\u8ffd\u8e64\u4e2d', visited: '\u5df2\u62dc\u8a2a', closed: '\u5df2\u7d50\u6848' };
  return labels[status] || '';
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
