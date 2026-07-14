import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from '@playwright/test';

const ADMIN_PASSWORD = 'agentdeck-test-password';

test('settings sheet opens, navigates providers, and does not black screen', async () => {
  const port = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-settings-e2e-'));
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: path.join(dir, 'data'),
      RUNTIME_DB: path.join(dir, 'runtime.sqlite3'),
      ADMIN_PASSWORD,
      COOKIE_SECRET: 'agentdeck-test-cookie-secret-1234567890',
      PORT: String(port),
      ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
      USE_AGENT_RUNTIME: '0',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));

  let browser;
  try {
    await waitForServer(port, child, output);
    browser = await chromium.launch({ headless:true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.stack || err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.addInitScript(() => {
      window.addEventListener('unhandledrejection', event => {
        console.error('unhandledrejection', event.reason?.stack || event.reason?.message || event.reason);
      });
    });

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil:'domcontentloaded' });
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button').filter({ hasText:'登录' }).click();
    await page.locator('.sessionList').waitFor({ timeout:15000 });

    await page.getByLabel('设置').click();
    await page.locator('.sheet').waitFor({ timeout:3000 });
    await assertNotBlack(page);

    await page.getByRole('button', { name:'Agent', exact:true }).click();
    await page.getByRole('button', { name:'返回', exact:true }).click();
    await page.getByRole('button', { name:'Agent', exact:true }).waitFor({ timeout:3000 });
    await page.getByRole('button', { name:'Agent', exact:true }).click();
    for (const provider of ['Codex', 'Claude Code', 'Antigravity']) {
      await page.getByRole('button', { name:new RegExp(`^${provider}`) }).click();
      await page.getByRole('button', { name:'返回', exact:true }).click();
      await page.getByRole('button', { name:'当前账户' }).click();
      await page.locator('.sheet header b').filter({ hasText:`${provider} 账户` }).waitFor({ timeout:3000 });
      await assertNotBlack(page);
      await page.getByRole('button', { name:'返回', exact:true }).click();
      await page.getByRole('button', { name:'Agent' }).click();
    }

    await page.getByRole('button', { name:/^Codex/ }).click();
    await page.getByRole('button', { name:'关闭', exact:true }).click();
    await page.getByLabel('设置').click();
    await page.locator('.sheet').waitFor({ timeout:3000 });
    await page.getByRole('button', { name:'当前账户' }).click();
    await page.locator('.profileRow button.dangerText').first().click();
    await page.getByText('删除 Codex 账户？').waitFor({ timeout:3000 });
    await page.getByRole('button', { name:'取消' }).click();
    await assert.equal(await page.getByText('删除 Codex 账户？').count(), 0);
    await assertNotBlack(page);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if(child.exitCode===null)child.kill('SIGTERM');
    await new Promise(resolve => child.exitCode===null ? child.once('exit', resolve) : resolve());
    await rm(dir, { recursive:true, force:true });
  }
});

async function assertNotBlack(page) {
  const text = (await page.locator('body').innerText()).trim();
  assert.notEqual(text, '', 'body text should not be empty');
  assert.equal(await page.locator('.sheet').count(), 1, 'settings sheet should be visible');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(port, child, output) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${output.join('')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start\n${output.join('')}`);
}
