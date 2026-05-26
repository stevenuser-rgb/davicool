const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app-db.json');
const SESSION_TTL = 1000 * 60 * 60 * 12;
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/185NZwvJFPTsgi0H99mpl8KsDg_cMxxRbIwGu0N2Agko/export?format=csv';
const SHEET_WRITE_URL = clean(process.env.GOOGLE_SHEET_WRITE_URL);
const SHEET_WRITE_SECRET = clean(process.env.GOOGLE_SHEET_WRITE_SECRET);
const sessions = new Map();

const defaultDb = { users: [], customerStates: {}, auditLogs: [] };
const contentTypes = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };

main().catch((error) => { console.error(error); process.exit(1); });

async function main() {
  await ensureDb();
  http.createServer((req, res) => handle(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: 'SERVER_ERROR', message: '伺服器發生錯誤。' });
  })).listen(PORT, HOST, () => console.log(`Listening on ${HOST}:${PORT}`));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const db = await readDb();
    const user = db.users.find((u) => u.username === body.username && u.active !== false);
    if (!user || !verifyPassword(body.password || '', user.password)) {
      await audit(db, null, 'LOGIN_FAILED', { username: body.username || '' }, false);
      await writeDb(db);
      return json(res, 401, { error: 'INVALID_LOGIN', message: '帳號或密碼錯誤。' });
    }
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
    await audit(db, user, 'LOGIN', {}, true);
    await writeDb(db);
    res.setHeader('Set-Cookie', `factory_crm_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
    return json(res, 200, { user: publicUser(user) });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const sessionId = getSessionId(req);
    if (sessionId) sessions.delete(sessionId);
    const db = await readDb();
    await audit(db, auth.user, 'LOGOUT', {}, true);
    await writeDb(db);
    res.setHeader('Set-Cookie', 'factory_crm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { user: publicUser(auth.user) });
  if (req.method === 'GET' && url.pathname === '/api/factories.csv') return sendFactoriesCsv(res);
  if (req.method === 'GET' && url.pathname === '/api/sheet-sync-status') return json(res, 200, { enabled: Boolean(SHEET_WRITE_URL), hasSecret: Boolean(SHEET_WRITE_SECRET) });
  if (req.method === 'GET' && url.pathname === '/api/customer-states') {
    const db = await readDb();
    return json(res, 200, { customerStates: db.customerStates || {} });
  }

  const stateMatch = url.pathname.match(/^\/api\/customer-states\/(.+)$/);
  if (req.method === 'PUT' && stateMatch) {
    const customerId = decodeURIComponent(stateMatch[1]);
    const body = await readJson(req);
    const db = await readDb();
    const current = db.customerStates[customerId] || {};
    const customerState = {
      status: sanitizeStatus(body.status ?? current.status ?? 'todo'),
      grade: sanitizeGrade(body.grade ?? current.grade ?? ''),
      nextDate: clean(body.nextDate ?? current.nextDate ?? ''),
      note: clean(body.note ?? current.note ?? ''),
      updatedAt: new Date().toISOString(),
      updatedBy: auth.user.username
    };
    const sheetSync = await syncToSheet(customerId, customerState, auth.user);
    customerState.sheetSync = sheetSync;
    db.customerStates[customerId] = customerState;
    await audit(db, auth.user, 'SAVE_CUSTOMER_STATE', { customerId, status: customerState.status, grade: customerState.grade, sheetSync }, true);
    await writeDb(db);
    return json(res, 200, { customerState, sheetSync });
  }

  if (url.pathname.startsWith('/api/users') || url.pathname.startsWith('/api/audit-logs')) {
    if (auth.user.role !== 'admin') return json(res, 403, { error: 'FORBIDDEN', message: '需要管理員權限。' });
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    const db = await readDb();
    return json(res, 200, { users: db.users.map(publicUser) });
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    const body = await readJson(req);
    const db = await readDb();
    const username = clean(body.username);
    if (!username || !body.password) return json(res, 400, { error: 'INVALID_USER', message: '請輸入帳號與密碼。' });
    if (db.users.some((u) => u.username === username)) return json(res, 409, { error: 'USER_EXISTS', message: '帳號已存在。' });
    const user = { id: crypto.randomUUID(), username, displayName: clean(body.displayName) || username, role: body.role === 'admin' ? 'admin' : 'user', active: body.active !== false, password: hashPassword(String(body.password)), createdAt: new Date().toISOString() };
    db.users.push(user);
    await audit(db, auth.user, 'CREATE_USER', { username: user.username, role: user.role }, true);
    await writeDb(db);
    return json(res, 201, { user: publicUser(user) });
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PUT') {
    const db = await readDb();
    const user = db.users.find((u) => u.id === decodeURIComponent(userMatch[1]));
    if (!user) return json(res, 404, { error: 'USER_NOT_FOUND', message: '找不到使用者。' });
    const body = await readJson(req);
    user.displayName = clean(body.displayName ?? user.displayName) || user.username;
    user.role = body.role === 'admin' ? 'admin' : 'user';
    user.active = body.active !== false;
    if (body.password) user.password = hashPassword(String(body.password));
    user.updatedAt = new Date().toISOString();
    await audit(db, auth.user, 'UPDATE_USER', { username: user.username, role: user.role, active: user.active }, true);
    await writeDb(db);
    return json(res, 200, { user: publicUser(user) });
  }

  if (req.method === 'GET' && url.pathname === '/api/audit-logs') {
    const db = await readDb();
    return json(res, 200, { auditLogs: (db.auditLogs || []).slice(-150).reverse() });
  }

  return json(res, 404, { error: 'NOT_FOUND', message: '找不到 API。' });
}

async function serveStatic(req, res, url) {
  let file = url.pathname === '/' || url.pathname === '/factory-crm-app/' ? path.join(__dirname, 'index.html') : path.join(__dirname, decodeURIComponent(url.pathname.replace(/^\/factory-crm-app\/?/, '').replace(/^\//, '')));
  file = path.resolve(file);
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(__dirname, 'index.html');
  res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function sendFactoriesCsv(res) {
  try {
    const response = await fetch(SHEET_CSV_URL);
    if (!response.ok) throw new Error(`Google Sheet HTTP ${response.status}`);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await response.text());
  } catch {
    const fallback = path.join(__dirname, 'factories-sample.csv');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(fallback).pipe(res);
  }
}

async function syncToSheet(customerId, customerState, user) {
  if (!SHEET_WRITE_URL) return { enabled: false, ok: false, message: 'Google Sheet 寫回尚未設定。' };
  try {
    const response = await fetch(SHEET_WRITE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: SHEET_WRITE_SECRET, factoryId: customerId, grade: customerState.grade, status: customerState.status, nextDate: customerState.nextDate, note: customerState.note, updatedAt: customerState.updatedAt, updatedBy: user.username }) });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { ok: response.ok, raw: text.slice(0, 300) }; }
    return { enabled: true, ok: response.ok && payload.ok !== false, status: response.status, message: payload.message || (response.ok ? 'Google Sheet 已同步。' : 'Google Sheet 同步失敗。'), row: payload.row || null };
  } catch (error) {
    return { enabled: true, ok: false, message: error.message };
  }
}

async function ensureDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const db = structuredClone(defaultDb);
    db.users.push({ id: crypto.randomUUID(), username: 'admin', displayName: '系統管理員', role: 'admin', active: true, password: hashPassword('admin123'), createdAt: new Date().toISOString() });
    await writeDb(db);
  }
}
async function readDb() { return { ...structuredClone(defaultDb), ...JSON.parse(await fsp.readFile(DB_PATH, 'utf8')) }; }
async function writeDb(db) { await fsp.mkdir(DATA_DIR, { recursive: true }); await fsp.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }
async function requireAuth(req, res) {
  const sessionId = getSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.expiresAt < Date.now()) { if (sessionId) sessions.delete(sessionId); json(res, 401, { error: 'UNAUTHENTICATED', message: '請先登入。' }); return null; }
  session.expiresAt = Date.now() + SESSION_TTL;
  const db = await readDb();
  const user = db.users.find((u) => u.id === session.userId && u.active !== false);
  if (!user) { sessions.delete(sessionId); json(res, 401, { error: 'UNAUTHENTICATED', message: '使用者已停用。' }); return null; }
  return { user };
}
async function readJson(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {}; }
function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
function getSessionId(req) { const match = String(req.headers.cookie || '').match(/(?:^|;\s*)factory_crm_session=([^;]+)/); return match ? decodeURIComponent(match[1]) : ''; }
function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex'); return `${salt}:${hash}`; }
function verifyPassword(password, stored) { const [salt, expected] = String(stored || '').split(':'); if (!salt || !expected) return false; const actual = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex'); return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }
function publicUser(user) { return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, active: user.active !== false, createdAt: user.createdAt, updatedAt: user.updatedAt }; }
async function audit(db, user, action, details, success) { db.auditLogs = db.auditLogs || []; db.auditLogs.push({ id: crypto.randomUUID(), at: new Date().toISOString(), userId: user?.id || null, username: user?.username || null, action, success, details: details || {} }); if (db.auditLogs.length > 5000) db.auditLogs = db.auditLogs.slice(-5000); }
function clean(value) { return String(value ?? '').trim(); }
function sanitizeStatus(value) { return ['todo', 'follow', 'visited', 'closed'].includes(value) ? value : 'todo'; }
function sanitizeGrade(value) { const grade = clean(value).toUpperCase(); return ['AA', 'A', 'B', 'C', '潛能', '光多辦理', '未分級', ''].includes(grade) ? grade : grade.slice(0, 20); }
