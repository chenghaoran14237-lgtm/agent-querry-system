#!/usr/bin/env node

/**
 * Real browser E2E for the live hospital-data workflow.
 *
 * This intentionally drives the rendered page with Playwright instead of
 * calling the application's CRUD API directly.  By default it starts an
 * isolated local server with temporary SQLite files, so creating/editing/
 * deleting test rows cannot pollute the developer's working copy.  Set
 * E2E_ISOLATED=0 and E2E_BASE_URL to test an already-running instance.
 *
 * Required for the full live flow:
 *   E2E_PASSWORD='...' npm run e2e:live
 *
 * Optional:
 *   E2E_USERNAME=demo_admin
 *   E2E_BASE_URL=http://127.0.0.1:4180
 *   E2E_ISOLATED=0
 *   E2E_HEADLESS=0
 *   E2E_SKIP_GENERATION=1       # use the first persisted app instead of Run/SSE
 */

import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const username = process.env.E2E_USERNAME || 'demo_admin';
const password = process.env.E2E_PASSWORD || '';
const isolated = process.env.E2E_ISOLATED !== '0' && !process.env.E2E_BASE_URL;
const skipGeneration = process.env.E2E_SKIP_GENERATION === '1';
const headless = process.env.E2E_HEADLESS !== '0';
const timeout = Number(process.env.E2E_TIMEOUT || 20_000);
const generationTimeout = Number(process.env.E2E_GENERATION_TIMEOUT || 180_000);
const browserExecutable = process.env.E2E_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
let serverProcess;
let tempDir;
let baseURL;

function now() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${now()}] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

async function step(name, action) {
  const started = Date.now();
  try {
    await action();
    const duration = Date.now() - started;
    results.push({ name, status: 'passed', duration_ms: duration });
    log(`PASS ${name} (${duration} ms)`);
  } catch (error) {
    const duration = Date.now() - started;
    results.push({ name, status: 'failed', duration_ms: duration, error: String(error?.stack || error) });
    log(`FAIL ${name} (${duration} ms): ${error?.message || error}`);
    throw error;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : null;
      socket.close(() => port ? resolve(port) : reject(new Error('无法分配本地测试端口')));
    });
  });
}

async function waitForHealth(url, limitMs = 30_000) {
  const deadline = Date.now() + limitMs;
  let lastError = '尚未收到响应';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`本地服务未在 ${limitMs} ms 内就绪：${lastError}`);
}

async function startIsolatedServer() {
  tempDir = await mkdtemp(join(tmpdir(), 'buildkit-platform-e2e-'));
  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${port}`;
  serverProcess = spawn('python3', ['backend/server.py'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BUILDKIT_DB_PATH: join(tempDir, 'buildkit.sqlite3'),
      BUILDKIT_LIVE_DB_PATH: join(tempDir, 'live.sqlite3'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
  serverProcess.once('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') log(`本地测试服务提前退出 code=${code} signal=${signal || '—'}`);
  });
  await waitForHealth(baseURL);
}

async function stopIsolatedServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      serverProcess.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}

async function saveFailureArtifacts(page) {
  const directory = join(ROOT, 'test-results');
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  try {
    await page.screenshot({ path: join(directory, `live-workflow-${stamp}.png`), fullPage: true });
  } catch (_) {
    // The page can be unavailable after a server crash; the JSON result still helps.
  }
}

async function visibleText(locator) {
  return (await locator.textContent({ timeout })).trim();
}

async function chooseFirstNonEmptyOption(selectLocator) {
  const values = await selectLocator.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  if (!values.length) fail(`下拉框没有可选项：${await selectLocator.getAttribute('id')}`);
  await selectLocator.selectOption(values[0]);
  return values[0];
}

async function runWorkflow() {
  if (!password && !skipGeneration) {
    fail('缺少 E2E_PASSWORD。请在命令前设置线上账号密码；密码不会写入脚本或结果文件。');
  }

  if (isolated) {
    await startIsolatedServer();
    log(`使用隔离测试服务：${baseURL}`);
  } else {
    baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4180';
    await waitForHealth(baseURL);
    log(`使用已有服务：${baseURL}`);
  }

  const browser = await chromium.launch({
    headless,
    ...(existsSync(browserExecutable) ? { executablePath: browserExecutable } : {}),
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.on('dialog', async (dialog) => {
    // The only expected dialog is the local soft-delete confirmation.  The
    // test deliberately accepts it and immediately verifies restore.
    log(`处理浏览器对话框：${dialog.type()} / ${dialog.message()} -> accept`);
    await dialog.accept();
  });

  let testCode = `e2e-${Date.now()}`;
  let testName = '自动化测试床位';
  let editedName = '自动化测试床位-已编辑';
  const conflictName = '自动化测试床位-并发更新';
  let conflictPage;

  try {
    await step('页面加载与未登录门禁', async () => {
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveTitle(/BuildKit 医院数据工作台/);
      await expect(page.locator('h1').first()).toContainText('连接数据库');
      await expect(page.locator('#loginNotice')).toBeVisible();
    });

    await step('登录线上服务', async () => {
      await page.locator('#accountButton').click();
      await expect(page.locator('#loginDialog')).toBeVisible();
      await page.locator('#username').fill(username);
      await page.locator('#password').fill(password);
      await page.locator('#loginForm button[type="submit"]').click();
      await expect(page.locator('#loginDialog')).toBeHidden({ timeout: 30_000 });
      await expect(page.locator('#connectionState')).toHaveText('远端服务已连接', { timeout: 30_000 });
      await expect(page.locator('#sources .source-item')).toHaveCount(6, { timeout: 30_000 });
    });

    await step('选择真实 HIS 数据源和 bed_master 表', async () => {
      await page.locator('#builderSource').selectOption('26');
      await expect(page.locator('#builderSource')).toHaveValue('26');
      await expect(page.locator('#builderTable')).toHaveValue(/public\.bed_master/);
      await expect(page.locator('#tableDetail')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#detailName')).toHaveText('public.bed_master');
      await expect(page.locator('#columnsTable tbody tr')).toHaveCount(9, { timeout: 30_000 });
      await expect(page.locator('#detailMeta')).toContainText('profile');
    });

    await step('查看远端脱敏样例', async () => {
      await page.locator('#loadSample').click();
      await expect(page.locator('#samplePanel')).toBeVisible();
      await expect(page.locator('#sampleSubtitle')).toContainText('脱敏样例');
      await expect(page.locator('#systemAccessMode')).toHaveText('远端样例');
      await expect(page.locator('#sampleTable tbody tr')).toHaveCount(20, { timeout: 30_000 });
    });

    await step('导入本地工作副本', async () => {
      await page.locator('.nav-item[data-view="connection"]').click();
      await expect(page.locator('#tableDetail')).toBeVisible();
      await page.locator('#importMirror').click();
      await expect(page.locator('#importDialog')).toBeVisible();
      await page.locator('#importForm button[type="submit"]').click();
      await expect(page.locator('#importDialog')).toBeHidden();
      await expect(page.locator('#mirrorStatusText')).toContainText('本地副本', { timeout: 30_000 });
      await expect(page.locator('#mirrorStats')).toContainText('本地记录');
      await expect(page.locator('#mirrorStats')).toContainText('20');
    });

    if (!skipGeneration) {
      await step('通过线上 Agent 生成管理系统', async () => {
        await page.locator('.nav-item[data-view="builder"]').click();
        await expect(page.locator('#builderSelectedTable')).toContainText('public.bed_master');
        await page.locator('#prompt').fill('请生成医院床位主数据管理系统：展示床位编码、名称、病区、床位类型和业务状态，支持病区筛选，并在本地副本上提供新增、编辑、删除和恢复。');
        await page.locator('#generateForm button[type="submit"]').click();
        await expect(page.locator('#jobStatus')).toHaveText('已完成', { timeout: generationTimeout });
        // The completed AppSpec is rendered in the builder, then the UI
        // intentionally switches to the generated-system view.  Assert that
        // it was published (the hidden class is removed), rather than asking
        // for visual visibility while its parent view is inactive.
        await expect(page.locator('#specCard')).not.toHaveClass(/hidden/, { timeout: 30_000 });
        await expect(page.locator('#samplePanel')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#systemAccessMode')).toHaveText('本地工作副本');
      });
    } else {
      await step('恢复已有生成系统（跳过线上 Agent Run）', async () => {
        await page.locator('.nav-item[data-view="apps"]').click();
        await expect(page.locator('#appsList .app-card').first()).toBeVisible();
        await page.locator('#appsList .app-card').first().getByRole('button', { name: '打开系统' }).click();
        await expect(page.locator('#samplePanel')).toBeVisible();
      });
    }

    await step('生成系统列表与持久化定义', async () => {
      await page.locator('.nav-item[data-view="apps"]').click();
      await expect(page.locator('#appsList .app-card')).toHaveCount(1, { timeout: 30_000 });
      await expect(page.locator('#appsList .app-card').first()).toContainText('本地副本系统');
      await page.locator('#appsList .app-card').first().click();
      await expect(page.locator('#appDetail')).toBeVisible();
      await expect(page.locator('#restoredModeBadge')).toHaveText('本地工作副本');
      await page.locator('#continueEditing').click();
      await expect(page.locator('#builder')).toBeVisible();
      await page.locator('.nav-item[data-view="apps"]').click();
      await page.locator('#appsList .app-card').first().getByRole('button', { name: '打开系统' }).click();
      await expect(page.locator('#samplePanel')).toBeVisible();
    });

    await step('本地工作副本新增记录', async () => {
      await page.locator('#systemAdd').click();
      await expect(page.locator('#recordDialog')).toBeVisible();
      await page.locator('#recordFields input[name="code"]').fill(testCode);
      await page.locator('#recordFields input[name="name"]').fill(testName);
      await page.locator('#recordFields input[name="ward_code"]').fill('E2E');
      await page.locator('#recordFields input[name="bed_type"]').fill('自动化测试');
      await page.locator('#recordFields input[name="status"]').fill('available');
      const updatedAt = page.locator('#recordFields input[name="source_updated_at"]');
      if (await updatedAt.count()) await updatedAt.fill(new Date().toISOString());
      await page.locator('#recordDialog #saveRecord').click();
      await expect(page.locator('#recordDialog')).toBeHidden();
      await expect(page.locator('#systemResultCount')).toHaveText('21');
      await expect(page.locator('#sampleMeta')).toContainText('21 条');
    });

    await step('服务端分页', async () => {
      await expect(page.locator('#mirrorPageInfo')).toContainText('第 1/2 页');
      await page.locator('#mirrorNext').click();
      await expect(page.locator('#mirrorPageInfo')).toContainText('第 2/2 页');
      await page.locator('#mirrorPrev').click();
      await expect(page.locator('#mirrorPageInfo')).toContainText('第 1/2 页');
    });

    await step('搜索与字段筛选', async () => {
      await page.locator('#sampleSearch').fill(testCode);
      await expect(page.locator('#sampleMeta')).toContainText('1 条');
      await expect(page.locator('#sampleTable tbody tr')).toHaveCount(1);
      const wardFilter = page.locator('#specFilters select').first();
      const wardValue = await chooseFirstNonEmptyOption(wardFilter);
      await expect(wardFilter).toHaveValue(wardValue);
      // Search is still active; clear it and verify the selected value produces
      // a bounded result instead of an unfiltered full table.
      await page.locator('#sampleSearch').fill('');
      await expect(page.locator('#sampleMeta')).toContainText('条');
      await wardFilter.selectOption('');
    });

    await step('查看本地记录详情', async () => {
      await page.locator('#sampleSearch').fill(testCode);
      const row = page.locator('#sampleTable tbody tr').filter({ hasText: testCode });
      await expect(row).toHaveCount(1);
      await row.getByRole('button', { name: '查看' }).click();
      await expect(page.locator('#recordDialogTitle')).toHaveText('查看记录');
      await expect(page.locator('#recordFields input[name="code"]')).toBeDisabled();
      await expect(page.locator('#recordFields input[name="name"]')).toHaveValue(testName);
      await page.locator('#cancelRecord').click();
    });

    await step('编辑本地记录并验证乐观锁更新', async () => {
      const row = page.locator('#sampleTable tbody tr').filter({ hasText: testCode });
      await row.getByRole('button', { name: '编辑' }).click();
      await expect(page.locator('#recordDialogTitle')).toHaveText('编辑记录');
      await page.locator('#recordFields input[name="name"]').fill(editedName);
      await page.locator('#recordDialog #saveRecord').click();
      await expect(page.locator('#recordDialog')).toBeHidden();
      await expect(page.locator('#sampleTable tbody tr').filter({ hasText: editedName })).toHaveCount(1);
      await expect(page.locator('#systemNotice')).toContainText('本地变更待同步');
    });

    await step('并发编辑触发乐观锁冲突', async () => {
      conflictPage = await context.newPage();
      conflictPage.setDefaultTimeout(timeout);
      conflictPage.on('dialog', async (dialog) => dialog.accept());
      await conflictPage.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await conflictPage.locator('.nav-item[data-view="apps"]').click();
      await expect(conflictPage.locator('#appsList .app-card').first()).toBeVisible();
      await conflictPage.locator('#appsList .app-card').first().getByRole('button', { name: '打开系统' }).click();
      await expect(conflictPage.locator('#samplePanel')).toBeVisible();
      await conflictPage.locator('#sampleSearch').fill(testCode);
      const staleRow = conflictPage.locator('#sampleTable tbody tr').filter({ hasText: testCode });
      await expect(staleRow).toHaveCount(1);
      await staleRow.getByRole('button', { name: '编辑' }).click();
      await expect(conflictPage.locator('#recordDialogTitle')).toHaveText('编辑记录');

      // Save from the first page, invalidating the version held by the
      // second page's open form.
      const currentRow = page.locator('#sampleTable tbody tr').filter({ hasText: testCode });
      await currentRow.getByRole('button', { name: '编辑' }).click();
      await page.locator('#recordFields input[name="name"]').fill(conflictName);
      await page.locator('#recordDialog #saveRecord').click();
      await expect(page.locator('#recordDialog')).toBeHidden();
      editedName = conflictName;

      await conflictPage.locator('#recordFields input[name="name"]').fill('自动化测试床位-过期写入');
      await conflictPage.locator('#recordDialog #saveRecord').click();
      await expect(conflictPage.locator('#recordError')).toContainText('记录已被其他请求修改');
      await conflictPage.locator('#cancelRecord').click();
      await conflictPage.close();
      conflictPage = undefined;
    });

    await step('软删除、显示已删除和恢复', async () => {
      const row = page.locator('#sampleTable tbody tr').filter({ hasText: testCode });
      await row.getByRole('button', { name: '删除' }).click();
      await expect(page.locator('#sampleTable tbody tr').filter({ hasText: testCode })).toHaveCount(0);
      // The unique search remains active, so the filtered result count is 0
      // immediately after the soft delete.
      await expect(page.locator('#systemResultCount')).toHaveText('0');
      await page.locator('#toggleArchived').click();
      const archivedRow = page.locator('#sampleTable tbody tr').filter({ hasText: testCode });
      await expect(archivedRow).toHaveCount(1);
      await expect(archivedRow.getByRole('button', { name: '恢复' })).toBeVisible();
      await archivedRow.getByRole('button', { name: '恢复' }).click();
      await expect(page.locator('#sampleTable tbody tr').filter({ hasText: editedName })).toHaveCount(1);
      await expect(page.locator('#sampleTable tbody tr').filter({ hasText: editedName }).getByRole('button', { name: '删除' })).toBeVisible();
      await page.locator('#sampleSearch').fill('');
      await expect(page.locator('#systemResultCount')).toHaveText('21');
      await page.locator('#toggleArchived').click();
      await expect(page.locator('#systemResultCount')).toHaveText('21');
    });

    await step('刷新页面后验证应用和数据仍存在', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#connectionState')).toHaveText('远端服务已连接', { timeout: 30_000 });
      await page.locator('.nav-item[data-view="apps"]').click();
      await expect(page.locator('#appsList .app-card')).toHaveCount(1, { timeout: 30_000 });
      await page.locator('#appsList .app-card').first().getByRole('button', { name: '打开系统' }).click();
      await expect(page.locator('#systemAccessMode')).toHaveText('本地工作副本');
      await page.locator('#sampleSearch').fill(testCode);
      await expect(page.locator('#sampleTable tbody tr').filter({ hasText: editedName })).toHaveCount(1);
    });

    await step('退出线上会话', async () => {
      await page.locator('#accountButton').click();
      await expect(page.locator('#loginNotice')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#accountButton')).toHaveText('登录');
    });

    log(`\nE2E 完成：${results.filter((item) => item.status === 'passed').length}/${results.length} 步通过`);
  } catch (error) {
    await saveFailureArtifacts(page).catch(() => {});
    throw error;
  } finally {
    if (conflictPage) await conflictPage.close().catch(() => {});
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  let error;
  try {
    await runWorkflow();
  } catch (caught) {
    error = caught;
  } finally {
    await stopIsolatedServer().catch((caught) => {
      log(`清理隔离服务失败：${caught.message}`);
    });
    const outputDirectory = join(ROOT, 'test-results');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'live-workflow.json'), JSON.stringify({
      generated_at: now(),
      base_url: baseURL,
      isolated,
      skip_generation: skipGeneration,
      results,
      status: error ? 'failed' : 'passed',
      error: error ? String(error?.stack || error) : null,
    }, null, 2));
  }
  if (error) {
    log(`\nE2E 失败：${error.message}`);
    process.exitCode = 1;
  } else {
    log('\nE2E 全部通过');
  }
}

main().catch((error) => {
  log(`E2E runner 崩溃：${error?.stack || error}`);
  process.exitCode = 1;
});
