// Paste this at the bottom of your existing Apps Script. Do not overwrite your current script.
// Also add WRITEBACK_SECRET to CONFIG, for example:
// WRITEBACK_SECRET: "factory-crm-2026-secret"

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : "{}");
    if (CONFIG.WRITEBACK_SECRET && payload.secret !== CONFIG.WRITEBACK_SECRET) {
      return writebackJson_({ ok: false, message: "Invalid secret" });
    }
    var factoryId = String(payload.factoryId || "").trim();
    if (!factoryId) return writebackJson_({ ok: false, message: "Missing factoryId" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var mainSheet = ss.getSheetByName(CONFIG.SHEET_DATA);
    if (!mainSheet) return writebackJson_({ ok: false, message: "找不到總表：" + CONFIG.SHEET_DATA });

    var result = writebackUpdateMainSheet_(ss, mainSheet, payload);
    if (!result.ok) return writebackJson_(result);
    writebackAppendHistory_(ss, payload, result.rowValues);
    writebackSyncSourceSheet_(ss, payload);
    return writebackJson_({ ok: true, message: "Google Sheet 已寫回", row: result.row });
  } catch (error) {
    return writebackJson_({ ok: false, message: error.message });
  }
}

function writebackUpdateMainSheet_(ss, sheet, payload) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: false, message: "總表沒有資料" };
  var headers = data[0].map(function(v) { return String(v || "").trim(); });
  var idIdx = findColumnIndex(headers, ["工廠登記編號", "廠編", "編號"]);
  var gradeIdx = findColumnIndex(headers, ["客戶分級", "分級", "等級"]);
  var logIdx = findColumnIndex(headers, ["拜訪回報", "拜訪紀錄", "進度回報", "回報", "進度"]);
  var statusCol = writebackEnsureHeader_(sheet, headers, "追蹤狀態");
  var nextDateCol = writebackEnsureHeader_(sheet, headers, "下次追蹤日");
  var updatedByCol = writebackEnsureHeader_(sheet, headers, "系統更新者");
  var updatedAtCol = writebackEnsureHeader_(sheet, headers, "系統更新時間");
  if (idIdx === -1) return { ok: false, message: "總表找不到工廠登記編號欄位" };

  var target = writebackNormalizeId_(payload.factoryId);
  for (var i = 1; i < data.length; i++) {
    if (writebackNormalizeId_(data[i][idIdx]) === target) {
      var rowNumber = i + 1;
      if (gradeIdx !== -1) sheet.getRange(rowNumber, gradeIdx + 1).setValue(payload.grade || "");
      if (logIdx !== -1 && payload.note) {
        var displayLog = writebackBuildDisplayLog_(payload);
        var oldLog = sheet.getRange(rowNumber, logIdx + 1).getValue();
        if (String(oldLog || "").indexOf(payload.note) === -1) {
          sheet.getRange(rowNumber, logIdx + 1).setValue(oldLog ? displayLog + "\n" + oldLog : displayLog);
        }
      }
      sheet.getRange(rowNumber, statusCol).setValue(writebackStatusLabel_(payload.status));
      sheet.getRange(rowNumber, nextDateCol).setValue(payload.nextDate || "");
      sheet.getRange(rowNumber, updatedByCol).setValue(payload.updatedBy || "");
      sheet.getRange(rowNumber, updatedAtCol).setValue(payload.updatedAt || new Date().toISOString());
      return { ok: true, row: rowNumber, rowValues: { region: data[i][0], factoryId: data[i][idIdx], companyName: data[i][2] } };
    }
  }
  return { ok: false, message: "找不到工廠登記編號：" + payload.factoryId };
}

function writebackAppendHistory_(ss, payload, rowValues) {
  if (!payload.note) return;
  var historySheet = ss.getSheetByName(CONFIG.SHEET_HISTORY);
  if (!historySheet) {
    historySheet = ss.insertSheet(CONFIG.SHEET_HISTORY);
    historySheet.appendRow(["紀錄時間", "所屬區域", "工廠登記編號", "公司名稱", "拜訪回報內容", "來源"]);
  }
  var currentTime = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd HH:mm");
  historySheet.appendRow([currentTime, rowValues.region || "", payload.factoryId || "", rowValues.companyName || "", payload.note || "", "Web App"]);
}

function writebackSyncSourceSheet_(ss, payload) {
  if (!payload.note) return;
  var sourceSheetNames = getAutoSourceSheetNames(ss);
  var target = writebackNormalizeId_(payload.factoryId);
  var displayLog = writebackBuildDisplayLog_(payload);
  for (var i = 0; i < sourceSheetNames.length; i++) {
    var sheet = ss.getSheetByName(sourceSheetNames[i]);
    if (!sheet) continue;
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) continue;
    var headers = data[0].map(function(v) { return String(v || "").trim(); });
    var idIdx = findColumnIndex(headers, ["工廠登記編號", "廠編", "編號"]);
    var gradeIdx = findColumnIndex(headers, ["客戶分級", "分級", "等級"]);
    var logIdx = findColumnIndex(headers, ["拜訪回報", "拜訪紀錄", "進度回報", "回報", "進度"]);
    if (idIdx === -1) continue;
    for (var r = 1; r < data.length; r++) {
      if (writebackNormalizeId_(data[r][idIdx]) === target) {
        if (gradeIdx !== -1) sheet.getRange(r + 1, gradeIdx + 1).setValue(payload.grade || "");
        if (logIdx !== -1) {
          var oldLog = sheet.getRange(r + 1, logIdx + 1).getValue();
          if (String(oldLog || "").indexOf(payload.note) === -1) {
            sheet.getRange(r + 1, logIdx + 1).setValue(oldLog ? displayLog + "\n" + oldLog : displayLog);
          }
        }
        return;
      }
    }
  }
}

function writebackEnsureHeader_(sheet, headers, headerName) {
  var index = headers.indexOf(headerName);
  if (index !== -1) return index + 1;
  var column = headers.length + 1;
  sheet.getRange(1, column).setValue(headerName);
  headers.push(headerName);
  return column;
}
function writebackBuildDisplayLog_(payload) {
  var todayShort = Utilities.formatDate(new Date(), "GMT+8", "MM/dd");
  var by = payload.updatedBy ? "（" + payload.updatedBy + "）" : "";
  return "【" + todayShort + "】 " + payload.note + by;
}
function writebackNormalizeId_(value) { return String(value || "").trim().toUpperCase(); }
function writebackStatusLabel_(status) {
  var labels = { todo: "未處理", follow: "待追蹤", visited: "已拜訪", closed: "暫不處理" };
  return labels[status] || "未處理";
}
function writebackJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
