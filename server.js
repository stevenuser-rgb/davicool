const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const appRoot = __dirname;
const publicRoot = appRoot;
const dataDir = resolveDataDir();
const dbPath = path.join(dataDir, 'app-db.json');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const sessionTtlMs = 1000 * 60 * 60 * 12;
const sessions = new Map();

const sheetCsvUrl = 'https://docs.google.com/spreadsheets/d/185NZwvJFPTsgi0H99mpl8KsDg_cMxxRbIwGu0N2Agko/export?format=csv';
const sheetWriteUrl = cleanEnv(process.env.GOOGLE_SHEET_WRITE_URL);
const sheetWriteSecret = cleanEnv(process.env.GOOGLE_SHEET_WRITE_SECRET);
const remoteDbBackupEnabled = Boolean(sheetWriteUrl && sheetWriteSecret);

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
      sendJson(res, 500, { error: 'SERVER_ERROR', message: 'Server error.' });
    });
  });

  server.listen(port, host, () => {
    console.log(`http://${host}:${port}/factory-crm-app/`);
    console.log(`Data directory: ${dataDir}`);
    console.log(`Remote DB backup: ${remoteDbBackupEnabled ? 'enabled' : 'disabled'}`);
    if (isLikelyEphemeralDataDir() && !remoteDbBackupEnabled) {
      console.warn('WARNING: local filesystem is ephemeral and remote DB backup is disabled. Data may disappear after redeploy or restart.');
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
      sendJson(res, 401, { error: 'INVALID_LOGIN', message: '\u5e33\u865f\u6216\u5bc6\u78bc\u932f\u8aa4\u3002' });
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
    sendJson(res, 200, { enabled: Boolean(sheetWriteUrl), hasSecret: Boolean(sheetWriteSecret), remoteDbBackupEnabled });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/storage-status') {
    sendJson(res, 200, getStorageStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/customer-states') {
    const db = await readDb();
    sendJson(res, 200, { customerStates: db.customerStates || {}, customerProfiles: db.customerProfiles || {} });
    return;
  }

  const customerMatch = url.pathname.match(/^\/api\/customers\/(.+)$/);
  if (req.method === 'PUT' && customerMatch) {
    const storage = getStorageStatus();
    const customerId = decodeURIComponent(customerMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    db.customerProfiles = db.customerProfiles || {};
    const current = db.customerProfiles[customerId] || {};
    const customerProfile = {
      company: cleanString(body.company ?? current.company ?? ''),
      owner: cleanString(body.owner ?? current.owner ?? ''),
      phone: cleanString(body.phone ?? current.phone ?? ''),
      address: cleanString(body.address ?? current.address ?? ''),
      updatedAt: new Date().toISOString(),
      updatedBy: auth.user.username
    };

    const sheetSync = await syncCustomerProfileToSheet(customerId, customerProfile, auth.user);
    customerProfile.sheetSync = sheetSync;
    db.customerProfiles[customerId] = customerProfile;
    await writeAudit(db, auth.user, 'UPDATE_CUSTOMER_PROFILE', {
      customerId,
      fields: Object.keys(body || {}),
      sheetSync
    }, true);
    await writeDbAndVerify(
      db,
      saved => saved.customerProfiles?.[customerId]?.updatedAt === customerProfile.updatedAt,
      '\u5ba2\u6236\u8cc7\u6599\u672a\u6210\u529f\u5beb\u5165\u8cc7\u6599\u5eab\u3002'
    );
    sendJson(res, 200, { customerProfile, sheetSync, storage });
    return;
  }

  const stateMatch = url.pathname.match(/^\/api\/customer-states\/(.+)$/);
  if (req.method === 'PUT' && stateMatch) {
    const storage = getStorageStatus();
    const customerId = decodeURIComponent(stateMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    const current = db.customerStates[customerId] || {};
    const customerState = {
      status: sanitizeStatus(body.status ?? current.status ?? 'todo'),
      grade: sanitizeGrade(body.grade ?? current.grade ?? ''),
      nextDate: cleanString(body.nextDate ?? current.nextDate ?? ''),
      note: cleanString(body.note ?? current.note ?? ''),
      updatedAt: new Date().toISOString(),
      updatedBy: auth.user.username
    };

    const sheetSync = await syncCustomerStateToSheet(customerId, customerState, auth.user);
    customerState.sheetSync = sheetSync;
    db.customerStates[customerId] = customerState;
    await writeAudit(db, auth.user, 'SAVE_CUSTOMER_STATE', {
      customerId,
      status: customerState.status,
      grade: customerState.grade,
      sheetSync
    }, true);
    await writeDbAndVerify(
      db,
      saved => saved.customerStates?.[customerId]?.updatedAt === customerState.updatedAt,
      '\u8ffd\u8e64\u7d00\u9304\u672a\u6210\u529f\u5beb\u5165\u8cc7\u6599\u5eab\u3002'
    );
    sendJson(res, 200, { customerState, sheetSync, storage });
    return;
  }

  if (url.pathname.startsWith('/api/users') || url.pathname.startsWith('/api/audit-logs')) {
    if (auth.user.role !== 'admin') {
      sendJson(res, 403, { error: 'FORBIDDEN', message: '\u9700\u8981\u7ba1\u7406\u54e1\u6b0a\u9650\u3002' });
      return;
    }
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
      sendJson(res, 400, { error: 'INVALID_USER', message: '\u8acb\u8f38\u5165\u5e33\u865f\u8207\u5bc6\u78bc\u3002' });
      return;
    }
    if (db.users.some(user => user.username === username)) {
      sendJson(res, 409, { error: 'USER_EXISTS', message: '\u5e33\u865f\u5df2\u5b58\u5728\u3002' });
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
      '\u4f7f\u7528\u8005\u672a\u6210\u529f\u5beb\u5165\u8cc7\u6599\u5eab\u3002'
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
      sendJson(res, 404, { error: 'USER_NOT_FOUND', message: '\u627e\u4e0d\u5230\u4f7f\u7528\u8005\u3002' });
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
      '\u4f7f\u7528\u8005\u66f4\u65b0\u672a\u6210\u529f\u5beb\u5165\u8cc7\u6599\u5eab\u3002'
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

  sendJson(res, 404, { error: 'NOT_FOUND', message: '\u627e\u4e0d\u5230 API\u3002' });
}

async function serveStatic(req, res, url) {
  let requestPath = decodeURIComponent(url.pathname);
  if (requestPath === '/factory-crm-app' || requestPath.startsWith('/factory-crm-app/')) {
    requestPath = requestPath.replace(/^\/factory-crm-app\/?/, '/') || '/';
  }
  let file = path.resolve(publicRoot, requestPath.replace(/^\//, ''));
  if (!file.startsWith(publicRoot)) {
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
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function sendFactoriesCsv(res) {
  try {
    const response = await fetch(sheetCsvUrl);
    if (!response.ok) throw new Error(`Google Sheet HTTP ${response.status}`);
    const csv = await response.text();
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(csv);
  } catch {
    const fallback = path.join(appRoot, 'factories-sample.csv');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(fallback).pipe(res);
  }
}

async function syncCustomerStateToSheet(customerId, customerState, user) {
  if (!sheetWriteUrl) {
    return { enabled: false, ok: false, message: 'Google Sheet writeback is not configured.' };
  }

  try {
    const response = await fetch(sheetWriteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: sheetWriteSecret,
        factoryId: customerId,
        grade: customerState.grade,
        status: customerState.status,
        nextDate: customerState.nextDate,
        note: customerState.note,
        updatedAt: customerState.updatedAt,
        updatedBy: user.username
      })
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: response.ok, raw: text.slice(0, 300) };
    }
    return {
      enabled: true,
      ok: response.ok && payload.ok !== false,
      status: response.status,
      message: payload.message || (response.ok ? 'Google Sheet synced.' : 'Google Sheet sync failed.'),
      row: payload.row || null
    };
  } catch (error) {
    return { enabled: true, ok: false, message: error.message };
  }
}

async function syncCustomerProfileToSheet(customerId, customerProfile, user) {
  if (!sheetWriteUrl) {
    return { enabled: false, ok: false, message: 'Google Sheet writeback is not configured.' };
  }

  try {
    const response = await fetch(sheetWriteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: sheetWriteSecret,
        factoryId: customerId,
        company: customerProfile.company,
        owner: customerProfile.owner,
        phone: customerProfile.phone,
        address: customerProfile.address,
        updatedAt: customerProfile.updatedAt,
        updatedBy: user.username
      })
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: response.ok, raw: text.slice(0, 300) };
    }
    return {
      enabled: true,
      ok: response.ok && payload.ok !== false,
      status: response.status,
      message: payload.message || (response.ok ? 'Google Sheet synced.' : 'Google Sheet sync failed.'),
      row: payload.row || null
    };
  } catch (error) {
    return { enabled: true, ok: false, message: error.message };
  }
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
      displayName: '\u7cfb\u7d71\u7ba1\u7406\u54e1',
      role: 'admin',
      active: true,
      password: hashPassword('admin123'),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);
    await saveRemoteDbBackup(db);
  }
}

async function readDb() {
  const raw = (await fsp.readFile(dbPath, 'utf8')).replace(/^\uFEFF/, '');
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await fsp.mkdir(dataDir, { recursive: true });
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  let moved = false;
  try {
    await fsp.writeFile(tempPath, JSON.stringify(normalizeDb(db), null, 2), 'utf8');
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
  await saveRemoteDbBackup(saved);
  return saved;
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

async function postSheetAction(action, payload) {
  const response = await fetch(sheetWriteUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      secret: sheetWriteSecret,
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
    sendJson(res, 401, { error: 'UNAUTHENTICATED', message: '\u8acb\u5148\u767b\u5165\u3002' });
    return null;
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  const db = await readDb();
  const user = db.users.find(item => item.id === session.userId && item.active !== false);
  if (!user) {
    sessions.delete(sessionId);
    sendJson(res, 401, { error: 'UNAUTHENTICATED', message: '\u4f7f\u7528\u8005\u5df2\u505c\u7528\u3002' });
    return null;
  }
  return { user };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  return raw ? JSON.parse(raw) : {};
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
  return ['AA', 'A', 'B', 'C', 'D', '\u6f5b\u80fd', '\u5149\u591a\u8fa6\u7406', '\u672a\u5206\u7d1a', ''].includes(grade) ? grade : grade.slice(0, 20);
}
