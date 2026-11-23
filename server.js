const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createCustomerImporter, maxBytes: maxImportBytes } = require('./customer-import');

const appRoot = __dirname;
const publicRoot = appRoot;
const dataDir = resolveDataDir();
const dbPath = path.join(dataDir, 'app-db.json');
const sheetHistoryPath = path.join(dataDir, 'customer-sheet-history.json');
let sheetHistoryQueue = Promise.resolve();
let customerSheetRead;
let customerSheetWrites = 0;
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const sessionTtlMs = 1000 * 60 * 60 * 12;
const sessions = new Map();

const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/185NZwvJFPTsgi0H99mpl8KsDg_cMxxRbIwGu0N2Agko/export?format=csv';
const sheetWriteUrl = cleanEnv(process.env.GOOGLE_SHEET_WRITE_URL);
const sheetWriteSecret = cleanEnv(process.env.GOOGLE_SHEET_WRITE_SECRET);
const remoteDbBackupEnabled = Boolean(sheetWriteUrl && sheetWriteSecret);
const customerSheetId = cleanEnv(process.env.GOOGLE_SHEET_CUSTOMER_ID);
const customerSheetGid = cleanEnv(process.env.GOOGLE_SHEET_CUSTOMER_GID);
const customerSheetUrl = cleanEnv(process.env.GOOGLE_SHEET_CUSTOMER_API_URL);
const customerSheetSecret = cleanEnv(process.env.GOOGLE_SHEET_CUSTOMER_API_SECRET);
const legacySheetConnection = { url: sheetWriteUrl, secret: sheetWriteSecret };
const legacySheetTarget = { spreadsheetId: new URL(sheetCsvUrl).pathname.split('/')[3], gid: null };
const customerImportEnabled = process.env.CUSTOMER_IMPORT_ENABLED === '1' &&
  Boolean(customerSheetId && customerSheetGid && customerSheetUrl && customerSheetSecret);
const customerImporter = createCustomerImporter({ dataDir, call: async (action, payload) => {
  const target = getCustomerSheetTarget();
  const connection = getCustomerSheetConnection(target);
  try {
    return await postSheetAction(action, { target, ...payload }, connection, AbortSignal.timeout(45000));
  } catch {
    throw httpError(502, 'CUSTOMER_IMPORT_UNAVAILABLE', '無法確認匯入端點回應；若正在確認匯入，請重試同一批次。');
  }
} });

async function readSheetHistory() {
  try {
    return JSON.parse(await fsp.readFile(sheetHistoryPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { active: null, sources: {}, switches: [] };
  }
}

function recordSheetActivity(target, field) {
  const save = sheetHistoryQueue.then(async () => {
    const history = await readSheetHistory();
    const key = target.spreadsheetId + ':' + (target.gid ?? 'default');
    const at = new Date().toISOString();
    if (field === 'lastReadAt' && history.active !== key) {
      history.switches.push({ from: history.active, to: key, at });
      history.active = key;
    }
    history.sources[key] = { ...history.sources[key], ...target, [field]: at };
    const temp = sheetHistoryPath + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(history, null, 2), 'utf8');
    await fsp.rename(temp, sheetHistoryPath);
  });
  sheetHistoryQueue = save.catch(error => console.warn('Customer sheet activity could not be recorded:', error.message));
  return sheetHistoryQueue;
}

function getCustomerSheetTarget() {
  if (!customerSheetId && !customerSheetGid) return null;
  if (!/^[\w-]+$/.test(customerSheetId) || !/^\d+$/.test(customerSheetGid)) {
    throw httpError(503, 'SHEET_CONFIG_INVALID', 'Google Sheet customer source configuration is incomplete.');
  }
  return { spreadsheetId: customerSheetId, gid: customerSheetGid };
}

function getCustomerSheetConnection(target) {
  if (!target) return legacySheetConnection;
  if (customerSheetUrl || customerSheetSecret) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(customerSheetUrl) || customerSheetSecret.length < 32) {
      throw httpError(503, 'SHEET_CONFIG_INVALID', 'Google Sheet customer endpoint or secret is invalid.');
    }
    return { url: customerSheetUrl, secret: customerSheetSecret };
  }
  if (!remoteDbBackupEnabled) {
    throw httpError(503, 'SHEET_CONFIG_INVALID', 'Google Sheet customer endpoint is not configured.');
  }
  return legacySheetConnection;
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

const defaultDb = {
  users: [],
  salespeople: [],
  customerStates: {},
  customerProfiles: {},
  auditLogs: []
};

start().catch(error => {
  console.error(error);
  process.exit(1);
});

async function start() {
  await ensureDb();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error(error);
      if (error.httpStatus) {
        sendJson(res, error.httpStatus, { error: error.code || 'REQUEST_ERROR', message: error.message });
        return;
      }
      sendJson(res, 500, { error: 'SERVER_ERROR', message: '伺服器發生錯誤。' });
    });
  });

  server.listen(port, host, () => {
    console.log(`http://${host}:${port}/factory-crm-app/`);
    console.log(`Data directory: ${dataDir}`);
    if (isLikelyEphemeralDataDir()) {
      console.warn('WARNING: DATA_DIR is not set to a known persistent disk path. User and customer changes may disappear after a redeploy or restart.');
    }
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const db = await readDb();
    const user = db.users.find(item => item.username === body.username && item.active !== false);
    if (!user || !verifyPassword(body.password || '', user.password)) {
      await writeAudit(db, null, 'LOGIN_FAILED', { username: body.username || '' }, false);
      await writeDb(db);
      sendJson(res, 401, { error: 'INVALID_LOGIN', message: '登入失敗，帳號或密碼錯誤。' });
      return;
    }

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { userId: user.id, expiresAt: Date.now() + sessionTtlMs });
    await writeAudit(db, user, 'LOGIN', {}, true);
    await writeDb(db);
    setSessionCookie(res, sessionId);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (url.pathname.startsWith('/api/customer-import/')) {
    if (auth.user.role !== 'admin') {
      throw httpError(403, 'FORBIDDEN', '需要管理員權限。');
    }
    const operation = url.pathname.slice('/api/customer-import/'.length);
    if (req.method === 'GET' && operation === 'status') {
      sendJson(res, 200, { enabled: customerImportEnabled });
      return;
    }
    if (!customerImportEnabled) {
      throw httpError(503, 'CUSTOMER_IMPORT_DISABLED', '尚未啟用名單匯入。');
    }
    if (req.method === 'GET' && operation === 'history') {
      sendJson(res, 200, { receipts: await customerImporter.history() });
      return;
    }
    if (req.method === 'POST' && ['preview', 'commit'].includes(operation)) {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw httpError(415, 'CUSTOMER_IMPORT_FORMAT', '匯入請求格式不正確。');
      }
      const body = await readJson(req, Math.ceil(maxImportBytes / 3) * 4 + 4096);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw httpError(400, 'CUSTOMER_IMPORT_FORMAT', '匯入請求格式不正確。');
      }
      const result = operation === 'preview'
        ? await customerImporter.preview(body, auth.user)
        : await customerImporter.commit(body.batchId, auth.user);
      sendJson(res, 200, result);
      return;
    }
    throw httpError(404, 'NOT_FOUND', '找不到匯入功能。');
  }

  if (req.method === 'GET' && url.pathname === '/api/customer-sheet-history') {
    if (auth.user.role !== 'admin') {
      sendJson(res, 403, { error: 'FORBIDDEN', message: 'Administrator access is required.' });
      return;
    }
    sendJson(res, 200, await readSheetHistory());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const sessionId = getSessionId(req);
    if (sessionId) sessions.delete(sessionId);
    const db = await readDb();
    await writeAudit(db, auth.user, 'LOGOUT', {}, true);
    await writeDb(db);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    sendJson(res, 200, { user: publicUser(auth.user) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/factories.csv') {
    await sendFactoriesCsv(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sheet-sync-status') {
    const connection = getCustomerSheetConnection(getCustomerSheetTarget());
    sendJson(res, 200, { enabled: Boolean(connection.url), hasSecret: Boolean(connection.secret) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/storage-status') {
    sendJson(res, 200, getStorageStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/customer-states') {
    const db = await readDb();
    const target = getCustomerSheetTarget() || legacySheetTarget;
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${target.spreadsheetId}/edit`
      + (target.gid === null ? '' : `#gid=${target.gid}`);
    sendJson(res, 200, {
      customerStates: db.customerStates || {},
      customerProfiles: db.customerProfiles || {},
      salespeople: db.salespeople || [],
      sheetUrl
    });
    return;
  }

  const customerMatch = url.pathname.match(/^\/api\/customers\/(.+)$/);
  if (req.method === 'PUT' && customerMatch) {
    const storage = getStorageStatus();
    const customerKey = decodeURIComponent(customerMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    db.customerProfiles = db.customerProfiles || {};
    const current = db.customerProfiles[customerKey] || {};
    const customerProfile = {
      company: cleanString(body.company ?? current.company ?? ''),
      owner: cleanString(body.owner ?? current.owner ?? ''),
      phone: cleanString(body.phone ?? current.phone ?? ''),
      address: cleanString(body.address ?? current.address ?? ''),
      updatedAt: new Date().toISOString(),
      updatedBy: auth.user.username
    };

    const sheetSync = await syncCustomerProfileToSheet(customerKey, customerProfile, auth.user, body);
    customerProfile.sheetSync = sheetSync;
    db.customerProfiles[customerKey] = customerProfile;
    await writeAudit(db, auth.user, 'UPDATE_CUSTOMER_PROFILE', {
      customerKey,
      factoryId: cleanString(body.factoryId || customerKey),
      fields: Object.keys(body || {}),
      sheetSync
    }, true);
    await writeDbAndVerify(
      db,
      saved => saved.customerProfiles?.[customerKey]?.updatedAt === customerProfile.updatedAt,
      '�Ȥ��ƥ����\�g�J��Ʈw�C'
    );
    sendJson(res, 200, { customerProfile, sheetSync, storage });
    return;
  }

  const stateMatch = url.pathname.match(/^\/api\/customer-states\/(.+)$/);
  if (req.method === 'PUT' && stateMatch) {
    const storage = getStorageStatus();
    const customerKey = decodeURIComponent(stateMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    const current = db.customerStates[customerKey] || {};
    const customerState = {
      status: sanitizeStatus(body.status ?? current.status ?? 'todo'),
      grade: sanitizeGrade(body.grade ?? current.grade ?? ''),
      nextDate: cleanString(body.nextDate ?? current.nextDate ?? ''),
      note: cleanString(body.note ?? current.note ?? ''),
      salesperson: cleanString(body.salesperson ?? current.salesperson ?? ''),
      agencyType: cleanString(body.agencyType ?? current.agencyType ?? ''),
      updatedAt: new Date().toISOString(),
      updatedBy: auth.user.username
    };

    const sheetSync = await syncCustomerStateToSheet(customerKey, customerState, auth.user, body);
    customerState.sheetSync = sheetSync;
    db.customerStates[customerKey] = customerState;
    await writeAudit(db, auth.user, 'SAVE_CUSTOMER_STATE', {
      customerKey,
      factoryId: cleanString(body.factoryId || customerKey),
      status: customerState.status,
      grade: customerState.grade,
      salesperson: customerState.salesperson,
      agencyType: customerState.agencyType,
      sheetSync
    }, true);
    await writeDbAndVerify(
      db,
      saved => saved.customerStates?.[customerKey]?.updatedAt === customerState.updatedAt,
      '�l�ܬ��������\�g�J��Ʈw�C'
    );
    sendJson(res, 200, { customerState, sheetSync, storage });
    return;
  }

  if (url.pathname.startsWith('/api/users') || url.pathname.startsWith('/api/audit-logs') || url.pathname.startsWith('/api/salespeople')) {
    if (auth.user.role !== 'admin') {
      sendJson(res, 403, { error: 'FORBIDDEN', message: '需要管理員權限。' });
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/salespeople') {
    const db = await readDb();
    sendJson(res, 200, { salespeople: db.salespeople || [] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/salespeople') {
    const body = await readJson(req);
    const db = await readDb();
    db.salespeople = Array.isArray(db.salespeople) ? db.salespeople : [];
    const name = cleanString(body.name);
    if (!name) {
      sendJson(res, 400, { error: 'INVALID_SALESPERSON', message: '請輸入業務姓名。' });
      return;
    }
    if (db.salespeople.some(item => item.name === name)) {
      sendJson(res, 409, { error: 'SALESPERSON_EXISTS', message: '業務姓名已存在。' });
      return;
    }
    const salesperson = {
      id: crypto.randomUUID(),
      name,
      active: body.active !== false,
      createdAt: new Date().toISOString()
    };
    db.salespeople.push(salesperson);
    await writeAudit(db, auth.user, 'CREATE_SALESPERSON', { name }, true);
    await writeDbAndVerify(
      db,
      saved => saved.salespeople?.some(item => item.id === salesperson.id),
      '�~�ȤH�������\�g�J��Ʈw�C'
    );
    sendJson(res, 201, { salesperson });
    return;
  }

  const salespersonMatch = url.pathname.match(/^\/api\/salespeople\/([^/]+)$/);
  if (salespersonMatch && req.method === 'PUT') {
    const salespersonId = decodeURIComponent(salespersonMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    db.salespeople = Array.isArray(db.salespeople) ? db.salespeople : [];
    const salesperson = db.salespeople.find(item => item.id === salespersonId);
    if (!salesperson) {
      sendJson(res, 404, { error: 'SALESPERSON_NOT_FOUND', message: '找不到業務人員。' });
      return;
    }
    const name = cleanString(body.name ?? salesperson.name);
    if (!name) {
      sendJson(res, 400, { error: 'INVALID_SALESPERSON', message: '請輸入業務姓名。' });
      return;
    }
    salesperson.name = name;
    salesperson.active = body.active !== false;
    salesperson.updatedAt = new Date().toISOString();
    await writeAudit(db, auth.user, 'UPDATE_SALESPERSON', { name, active: salesperson.active }, true);
    await writeDbAndVerify(
      db,
      saved => saved.salespeople?.some(item => item.id === salesperson.id && item.updatedAt === salesperson.updatedAt),
      '�~�ȤH����s�����\�g�J��Ʈw�C'
    );
    sendJson(res, 200, { salesperson });
    return;
  }
  if (salespersonMatch && req.method === 'DELETE') {
    const salespersonId = decodeURIComponent(salespersonMatch[1]);
    const db = await readDb();
    db.salespeople = Array.isArray(db.salespeople) ? db.salespeople : [];
    const index = db.salespeople.findIndex(item => item.id === salespersonId);
    if (index === -1) {
      sendJson(res, 404, { error: 'SALESPERSON_NOT_FOUND', message: '找不到業務人員。' });
      return;
    }
    const [salesperson] = db.salespeople.splice(index, 1);
    await writeAudit(db, auth.user, 'DELETE_SALESPERSON', { id: salesperson.id, name: salesperson.name }, true);
    await writeDbAndVerify(
      db,
      saved => !saved.salespeople?.some(item => item.id === salesperson.id),
      '�~�ȤH���R�������\�g�J��Ʈw�C'
    );
    sendJson(res, 200, { ok: true, salesperson });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    const db = await readDb();
    sendJson(res, 200, { users: db.users.map(publicUser) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    const storage = getStorageStatus();
    const body = await readJson(req);
    const db = await readDb();
    const username = cleanString(body.username);
    if (!username || !body.password) {
      sendJson(res, 400, { error: 'INVALID_USER', message: '請輸入帳號和密碼。' });
      return;
    }
    if (db.users.some(user => user.username === username)) {
      sendJson(res, 409, { error: 'USER_EXISTS', message: '帳號已存在。' });
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      username,
      displayName: cleanString(body.displayName) || username,
      role: body.role === 'admin' ? 'admin' : 'user',
      active: body.active !== false,
      password: hashPassword(String(body.password)),
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    await writeAudit(db, auth.user, 'CREATE_USER', { username: user.username, role: user.role }, true);
    await writeDbAndVerify(
      db,
      saved => saved.users.some(item => item.id === user.id && item.username === user.username),
      '�ϥΪ̥����\�g�J��Ʈw�C'
    );
    sendJson(res, 201, { user: publicUser(user), storage });
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PUT') {
    const storage = getStorageStatus();
    const userId = decodeURIComponent(userMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    const user = db.users.find(item => item.id === userId);
    if (!user) {
      sendJson(res, 404, { error: 'USER_NOT_FOUND', message: '找不到使用者。' });
      return;
    }
    user.displayName = cleanString(body.displayName ?? user.displayName) || user.username;
    user.role = body.role === 'admin' ? 'admin' : 'user';
    user.active = body.active !== false;
    if (body.password) user.password = hashPassword(String(body.password));
    user.updatedAt = new Date().toISOString();
    await writeAudit(db, auth.user, 'UPDATE_USER', { username: user.username, role: user.role, active: user.active }, true);
    await writeDbAndVerify(
      db,
      saved => saved.users.some(item => item.id === user.id && item.updatedAt === user.updatedAt),
      '�ϥΪ̧�s�����\�g�J��Ʈw�C'
    );
    sendJson(res, 200, { user: publicUser(user), storage });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit-logs') {
    const db = await readDb();
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
    sendJson(res, 200, { auditLogs: (db.auditLogs || []).slice(-limit).reverse() });
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: '找不到 API。' });
}

async function serveStatic(req, res, url) {
  let requestPath = decodeURIComponent(url.pathname);
  if (requestPath === '/factory-crm-app' || requestPath.startsWith('/factory-crm-app/')) {
    requestPath = requestPath.replace(/^\/factory-crm-app\/?/, '/') || '/';
  }
  let file = path.resolve(publicRoot, requestPath.replace(/^\//, ''));
  if ((!file.startsWith(publicRoot + path.sep) && file !== publicRoot) ||
      file === dataDir || file.startsWith(dataDir + path.sep) ||
      path.basename(file).toLowerCase().startsWith('customer-sheet-history.json')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (path.basename(file) === 'index.html') {
    const html = await fsp.readFile(file, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function sendFactoriesCsv(res) {
  const target = getCustomerSheetTarget();
  if (target) {
    const result = await readCustomerSheet(target);
    if (result.ok !== true || typeof result.csv !== 'string') {
      throw httpError(502, 'SHEET_READ_FAILED', result.message || 'Google Sheet customer list could not be read.');
    }
    await recordSheetActivity(target, 'lastReadAt');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(result.csv);
    return;
  }
  try {
    const response = await fetch(sheetCsvUrl);
    if (!response.ok) throw new Error(`Google Sheet HTTP ${response.status}`);
    const csv = await response.text();
    if (response.headers.get('content-type')?.includes('text/csv')) {
      await recordSheetActivity(legacySheetTarget, 'lastReadAt');
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(csv);
  } catch {
    const fallback = path.join(appRoot, 'factories-sample.csv');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(fallback).pipe(res);
  }
}

async function readCustomerSheet(target) {
  const connection = getCustomerSheetConnection(target);
  if (customerSheetWrites > 0) return postSheetAction('readCustomerSheet', { target }, connection);
  if (customerSheetRead) return customerSheetRead;
  const request = postSheetAction('readCustomerSheet', { target }, connection);
  customerSheetRead = request;
  try {
    return await request;
  } finally {
    if (customerSheetRead === request) customerSheetRead = null;
  }
}

async function syncCustomerStateToSheet(customerKey, customerState, user, context = {}) {
  return syncCustomerToSheet({
    factoryId: cleanString(context.factoryId || customerKey),
    region: cleanString(context.region || ''),
    sourceCompany: cleanString(context.sourceCompany || ''),
    grade: customerState.grade,
    status: customerState.status,
    nextDate: customerState.nextDate,
    note: customerState.note,
    salesperson: customerState.salesperson,
    agencyType: customerState.agencyType,
    updatedAt: customerState.updatedAt,
    updatedBy: user.username
  });
}

async function syncCustomerToSheet(customer) {
  if (!sheetWriteUrl && !customerSheetId && !customerSheetGid) {
    return { enabled: false, ok: false, message: 'Google Sheet �g�^�|���]�w�C' };
  }

  try {
    const target = getCustomerSheetTarget();
    const connection = getCustomerSheetConnection(target);
    customerSheetRead = null;
    customerSheetWrites++;
    const { response, text } = await (async () => {
      const response = await fetch(connection.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(target
          ? { secret: connection.secret, action: 'writeCustomerSheet', target, customer }
          : { secret: connection.secret, ...customer })
      });
      return { response, text: await response.text() };
    })().finally(() => { customerSheetWrites--; });
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, message: 'Apps Script returned an invalid response.' };
    }
    const regionSynced = payload.regionSheetOk === true;
    if (response.ok && payload.ok === true) {
      await recordSheetActivity(target || legacySheetTarget, 'lastWriteAt');
    }
    return {
      enabled: true,
      ok: response.ok && payload.ok !== false && regionSynced,
      status: response.status,
      message: payload.message || (response.ok ? 'Google Sheet �w�P�B�C' : 'Google Sheet �P�B���ѡC'),
      row: payload.row || null,
      regionSheet: payload.regionSheet || '',
      regionSheetOk: regionSynced,
      regionSheetMessage: payload.regionSheetMessage || ''
    };
  } catch (error) {
    return { enabled: true, ok: false, message: error.message };
  }
}

function queueCustomerStateSync(customerKey, customerState, user, context = {}) {
  if (!sheetWriteUrl) {
    return { enabled: false, queued: false, ok: false, message: 'Google Sheet 寫回網址未設定' };
  }

  setTimeout(() => {
    syncCustomerStateToSheet(customerKey, customerState, user, context).catch(error => {
      console.warn(`Customer state sheet sync failed: ${error.message}`);
    });
  }, 0);

  return { enabled: true, queued: true, ok: true, message: 'Google Sheet 同步已排程' };
}
async function syncCustomerProfileToSheet(customerKey, customerProfile, user, context = {}) {
  return syncCustomerToSheet({
    factoryId: cleanString(context.factoryId || customerKey),
    region: cleanString(context.region || ''),
    sourceCompany: cleanString(context.sourceCompany || ''),
    company: customerProfile.company,
    owner: customerProfile.owner,
    phone: customerProfile.phone,
    address: customerProfile.address,
    updatedAt: customerProfile.updatedAt,
    updatedBy: user.username
  });
}
function queueCustomerProfileSync(customerKey, customerProfile, user, context = {}) {
  if (!sheetWriteUrl) {
    return { enabled: false, queued: false, ok: false, message: 'Google Sheet 寫回網址未設定' };
  }

  setTimeout(() => {
    syncCustomerProfileToSheet(customerKey, customerProfile, user, context).catch(error => {
      console.warn(`Customer profile sheet sync failed: ${error.message}`);
    });
  }, 0);

  return { enabled: true, queued: true, ok: true, message: 'Google Sheet 同步已排程' };
}
async function ensureDb() {
  await fsp.mkdir(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    const remoteDb = await loadRemoteDbBackup();
    if (remoteDb) {
      await writeDb(remoteDb);
      return;
    }

    const db = structuredClone(defaultDb);
    db.users.push({
      id: crypto.randomUUID(),
      username: 'admin',
      displayName: '�t�κ޲z��',
      role: 'admin',
      active: true,
      password: hashPassword('admin123'),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);
    await saveRemoteDbBackup(db).catch(error => {
      console.warn(`Initial remote DB backup failed: ${error.message}`);
    });
  }
}

async function readDb() {
  const raw = (await fsp.readFile(dbPath, 'utf8')).replace(/^\uFEFF/, '');
  return { ...structuredClone(defaultDb), ...JSON.parse(raw) };
}

async function writeDb(db) {
  await fsp.mkdir(dataDir, { recursive: true });
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  let moved = false;
  try {
    await fsp.writeFile(tempPath, JSON.stringify(db, null, 2), 'utf8');
    await fsp.rename(tempPath, dbPath);
    moved = true;
  } finally {
    if (!moved) await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function writeDbAndVerify(db, verifier, message) {
  await writeDb(db);
  const saved = await readDb();
  if (!verifier(saved)) {
    throw httpError(500, 'DB_WRITE_VERIFY_FAILED', message);
  }
  scheduleRemoteDbBackup(saved);
  return saved;
}

function scheduleRemoteDbBackup(db) {
  if (!remoteDbBackupEnabled) return;
  setTimeout(() => {
    saveRemoteDbBackup(db).catch(error => {
      console.warn(`Remote DB backup failed: ${error.message}`);
    });
  }, 0);
}
async function loadRemoteDbBackup() {
  if (!remoteDbBackupEnabled) return null;

  try {
    const payload = await postSheetAction('loadDbBackup', {});
    if (!payload.ok || !payload.db) return null;
    return normalizeDb(payload.db);
  } catch (error) {
    console.warn(`Remote DB backup load failed: ${error.message}`);
    return null;
  }
}

async function saveRemoteDbBackup(db) {
  if (!remoteDbBackupEnabled) return { enabled: false, ok: false };

  const payload = await postSheetAction('saveDbBackup', {
    db: normalizeDb(db),
    savedAt: new Date().toISOString()
  });
  if (!payload.ok) {
    throw httpError(502, 'DB_REMOTE_BACKUP_FAILED', payload.message || 'Google Sheet backend backup failed.');
  }
  return { enabled: true, ok: true, savedAt: payload.savedAt || null };
}

async function postSheetAction(action, payload, connection = legacySheetConnection, signal) {
  const response = await fetch(connection.url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      secret: connection.secret,
      action,
      ...payload
    })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, message: text.slice(0, 300) };
  }
  if (!response.ok) {
    throw httpError(502, 'SHEET_BACKUP_HTTP_ERROR', data.message || `Google Sheet HTTP ${response.status}`);
  }
  return data;
}

function normalizeDb(value) {
  const db = value && typeof value === 'object' ? value : {};
  return {
    users: Array.isArray(db.users) ? db.users : [],
    salespeople: Array.isArray(db.salespeople) ? db.salespeople : [],
    customerStates: db.customerStates && typeof db.customerStates === 'object' ? db.customerStates : {},
    customerProfiles: db.customerProfiles && typeof db.customerProfiles === 'object' ? db.customerProfiles : {},
    auditLogs: Array.isArray(db.auditLogs) ? db.auditLogs.slice(-5000) : []
  };
}

async function requireAuth(req, res) {
  const sessionId = getSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (sessionId) sessions.delete(sessionId);
    sendJson(res, 401, { error: 'UNAUTHENTICATED', message: '請先登入。' });
    return null;
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  const db = await readDb();
  const user = db.users.find(item => item.id === session.userId && item.active !== false);
  if (!user) {
    sessions.delete(sessionId);
    sendJson(res, 401, { error: 'UNAUTHENTICATED', message: '使用者已停用。' });
    return null;
  }
  return { user };
}

async function readJson(req, limit = Infinity) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw httpError(413, 'BODY_TOO_LARGE', '檔案不可超過 512 KB。');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw httpError(400, 'INVALID_JSON', '請求格式不正確。'); }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function setSessionCookie(res, sessionId) {
  res.setHeader('Set-Cookie', `factory_crm_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'factory_crm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function getSessionId(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)factory_crm_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function writeAudit(db, user, action, details, success) {
  db.auditLogs = db.auditLogs || [];
  db.auditLogs.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    userId: user?.id || null,
    username: user?.username || null,
    action,
    success,
    details: details || {}
  });
  if (db.auditLogs.length > 5000) db.auditLogs = db.auditLogs.slice(-5000);
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function cleanEnv(value) {
  const result = cleanString(value);
  return result || '';
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);

  const renderDiskPath = '/var/data';
  if (process.env.RENDER && fs.existsSync(renderDiskPath)) return renderDiskPath;

  return path.join(appRoot, 'data');
}

function getStorageStatus() {
  return {
    dataDir,
    dbPath,
    configuredByEnv: Boolean(process.env.DATA_DIR),
    render: Boolean(process.env.RENDER),
    likelyPersistent: !isLikelyEphemeralDataDir(),
    remoteBackupEnabled: remoteDbBackupEnabled
  };
}

function isLikelyEphemeralDataDir() {
  if (!process.env.RENDER) return false;
  const normalized = path.resolve(dataDir).replace(/\\/g, '/');
  return normalized !== '/var/data' && !normalized.startsWith('/var/data/');
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  return error;
}


function sanitizeStatus(value) {
  return ['todo', 'follow', 'visited', 'closed'].includes(value) ? value : 'todo';
}

function sanitizeGrade(value) {
  const grade = cleanString(value).toUpperCase();
  return ['AA', 'A', 'B', 'C', 'D', '���', '���h��z', '������', ''].includes(grade) ? grade : grade.slice(0, 20);
}
