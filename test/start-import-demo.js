const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixture, testTarget } = require('./fixture-sheet');

const secret = crypto.randomBytes(32).toString('hex');
const fixture = makeFixture(secret);
const fakeEndpoint = 'https://script.google.com/macros/s/LOCAL_FIXTURE/exec';
Object.assign(process.env, {
  HOST: '127.0.0.1', PORT: process.argv[2] || '8085',
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'davicool-import-demo-')),
  GOOGLE_SHEET_WRITE_URL: '', GOOGLE_SHEET_WRITE_SECRET: '',
  GOOGLE_SHEET_CUSTOMER_ID: testTarget.spreadsheetId,
  GOOGLE_SHEET_CUSTOMER_GID: testTarget.gid,
  GOOGLE_SHEET_CUSTOMER_API_URL: fakeEndpoint,
  GOOGLE_SHEET_CUSTOMER_API_SECRET: secret,
  CUSTOMER_IMPORT_ENABLED: '1'
});
delete process.env.RENDER;
global.fetch = async (url, options) => {
  if (url !== fakeEndpoint) throw new Error('The local demo cannot access external services.');
  const { action, secret: provided, ...payload } = JSON.parse(options.body);
  return new Response(JSON.stringify(fixture.call(action, payload, provided)), {
    headers: { 'Content-Type': 'application/json' }
  });
};
require('../server');
