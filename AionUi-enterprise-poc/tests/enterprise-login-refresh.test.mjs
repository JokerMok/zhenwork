import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = readFileSync('packages/desktop/src/process/services/enterprise/supervisor.ts', 'utf8');
const loginSource = source
  .slice(source.indexOf('function loginHtml('), source.indexOf('\nasync function clientVersionLabel()'))
  .replace(/function loginHtml\(labels: \{[\s\S]*?\}\): string \{/, 'function loginHtml(labels) {');
const loginHtml = new Function(`${loginSource};return loginHtml;`)();
const labels = {
  fallbackTitle: '企业账号',
  serverUrl: 'Server',
  origin: 'Origin',
  savedAccount: 'Saved',
  forgetAccount: 'Forget',
  rememberPassword: 'Remember',
  secureStorageUnavailable: 'Unavailable',
  savedPasswordHint: 'Saved password',
  versionLabel: '客户端版本 2.2.2 · 构建 98a21c6a',
};

test('login keeps connection settings optional and shows a build identifier', () => {
  const dom = new JSDOM(loginHtml(labels));
  try {
    const settings = dom.window.document.getElementById('connectionSettings');
    assert.equal(settings.open, false);
    assert.match(dom.window.document.getElementById('clientVersion').textContent, /2\.2\.2.*98a21c6a/);
    assert.equal(dom.window.document.querySelector('button[type="submit"]').textContent, '登录');
    assert.equal(dom.window.document.getElementById('brandTitle').textContent, '企业账号');
    assert.equal(dom.window.document.getElementById('serverUrl').required, true);
  } finally {
    dom.window.close();
  }
});

test('refreshing saved accounts does not block passwordless saved login', async () => {
  const accounts = { available: true, accounts: ['worker-a'] };
  let pendingRefresh;
  let deferRefresh = false;
  let submitted = 0;
  const dom = new JSDOM(loginHtml(labels), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.enterpriseLogin = {
        branding: async () => null,
        savedAccounts: () =>
          deferRefresh
            ? new Promise((resolve) => {
                pendingRefresh = resolve;
              })
            : Promise.resolve(accounts),
        forgetAccount: async () => {},
        submit: async () => {
          submitted += 1;
          return { ok: true };
        },
      };
    },
  });

  try {
    const { window } = dom;
    const document = window.document;
    document.getElementById('serverUrl').value = 'http://127.0.0.1:3589';
    document.getElementById('origin').value = 'http://127.0.0.1:3589';
    const settings = document.getElementById('connectionSettings');
    document.getElementById('serverUrl').dispatchEvent(new window.Event('invalid'));
    assert.equal(settings.open, true);
    await window.refreshSaved();
    assert.equal(document.getElementById('savedAccount').value, 'worker-a');
    assert.equal(document.getElementById('password').required, false);

    deferRefresh = true;
    window.dispatchEvent(new window.Event('focus'));
    document.querySelector('button[type="submit"]').click();
    assert.equal(submitted, 1);
    assert.equal(document.getElementById('password').required, false);
    pendingRefresh(accounts);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(document.getElementById('savedAccount').value, 'worker-a');
  } finally {
    dom.window.close();
  }
});
