#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const loginOnlyRequested = args.includes('--login-only');
const unknownArgs = args.filter(arg => !['--dry-run', '--login-only'].includes(arg));

if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
  console.error('Usage: node run.mjs [--dry-run] [--login-only]');
  process.exit(64);
}

const runnerPath = fileURLToPath(import.meta.url);
const repoRoot = findRepoRoot(path.dirname(runnerPath));
const productsPath = path.join(repoRoot, 'products.json');
const scriptPath = path.join(repoRoot, 'script.js');
const lockPath = path.join(repoRoot, '.novaventa-skill.lock');
const logsPath = path.join(repoRoot, 'logs');

let lockOwned = false;
let child = null;
let capturedOutput = '';
const startedAt = Date.now();

try {
  const products = loadProducts(productsPath);
  assertRuntime();
  assertDependencies(repoRoot);

  const envSummary = readEnvSummary(path.join(repoRoot, '.env'), repoRoot);
  const loginOnly = loginOnlyRequested || envSummary.loginOnly;
  const preflight = {
    repoRoot,
    productsFile: productsPath,
    productCount: products.length,
    unitCount: products.reduce((sum, product) => sum + product.quantity, 0),
    loginMode: envSummary.loginMode,
    loginModeSource: envSummary.loginModeSource,
    manualLogin: envSummary.manualLogin,
    loginOnly,
    headless: envSummary.headless,
    debugLogs: envSummary.debugLogs,
    credentialsConfigured: envSummary.credentialsConfigured,
    browserProfileExists: fs.existsSync(path.join(repoRoot, '.browser-profile-office')),
  };

  console.log(`NOVAVENTA_SKILL_PREFLIGHT=${JSON.stringify(preflight)}`);

  if (dryRun) {
    process.exit(0);
  }

  const previousRuns = new Set(listRunDirectories(logsPath));
  acquireLock(lockPath);
  lockOwned = true;

  child = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: loginOnlyRequested
      ? { ...process.env, NOVAVENTA_LOGIN_ONLY: 'true' }
      : process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  try {
    attachChildToLock(lockPath, child.pid);
  } catch (error) {
    if (Number.isInteger(child.pid)) child.kill('SIGTERM');
    throw error;
  }

  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    capturedOutput = appendOutput(capturedOutput, chunk);
  });
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
  });

  const forwardSignal = signal => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };

  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  const { code, signal } = await waitForChild(child);
  const debugRunDir = findNewRunDirectory(logsPath, previousRuns);
  const report =
    readStructuredReport(capturedOutput) ||
    (debugRunDir ? readTerminalEvent(path.join(debugRunDir, 'events.jsonl')) : null);
  const exitCode = Number.isInteger(code) ? code : 1;
  const status =
    exitCode !== 0 || signal || !report || report.event === 'unexpected-error'
      ? 'fatal'
      : report.event === 'run-end' && Number(report.errorCount || 0) > 0
        ? 'completed_with_errors'
        : 'completed';

  const result = {
    status,
    exitCode,
    signal: signal || null,
    elapsedMs: Date.now() - startedAt,
    debugRunDir: debugRunDir ? path.relative(repoRoot, debugRunDir) : null,
    report,
  };

  console.log(`NOVAVENTA_SKILL_RESULT=${JSON.stringify(result)}`);
  process.exitCode = exitCode;
} catch (error) {
  const result = {
    status: 'fatal',
    exitCode: 1,
    signal: null,
    elapsedMs: Date.now() - startedAt,
    debugRunDir: null,
    report: { event: 'wrapper-error', message: error.message },
  };
  console.error(error.message);
  console.log(`NOVAVENTA_SKILL_RESULT=${JSON.stringify(result)}`);
  process.exitCode = 1;
} finally {
  if (lockOwned) releaseLock(lockPath);
}

function findRepoRoot(startPath) {
  let current = path.resolve(startPath);
  const filesystemRoot = path.parse(current).root;

  while (true) {
    if (
      fs.existsSync(path.join(current, 'script.js')) &&
      fs.existsSync(path.join(current, 'package.json'))
    ) {
      return current;
    }
    if (current === filesystemRoot) break;
    current = path.dirname(current);
  }

  throw new Error('Could not locate the Novaventa repository root from the skill directory.');
}

function loadProducts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Products file not found: ${filePath}`);
  }

  let rawProducts;
  try {
    rawProducts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }

  if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
    throw new Error('products.json must contain a non-empty array.');
  }

  return rawProducts.map((product, index) => {
    const code = product?.code?.toString().trim();
    const quantity = Number(product?.quantity ?? 1);

    if (!code) {
      throw new Error(`Product at position ${index + 1} is missing a code.`);
    }
    if (!/^\d+$/.test(code)) {
      throw new Error(`Product code must contain only digits: ${code}`);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Product ${code} has an invalid quantity: ${product?.quantity}`);
    }

    return { code, quantity };
  });
}

function assertRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 18) {
    throw new Error(`Node.js 18 or newer is required; found ${process.version}.`);
  }
}

function assertDependencies(rootPath) {
  const requireFromRepo = createRequire(path.join(rootPath, 'package.json'));
  const missing = [];

  for (const dependency of ['dotenv', 'puppeteer', 'winston']) {
    try {
      requireFromRepo.resolve(dependency);
    } catch {
      missing.push(dependency);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing dependencies: ${missing.join(', ')}. Run npm ci in ${rootPath}.`);
  }
}

function readEnvSummary(envPath, rootPath) {
  const values = new Map();
  if (fs.existsSync(envPath)) {
    const requireFromRepo = createRequire(path.join(rootPath, 'package.json'));
    const dotenv = requireFromRepo('dotenv');
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const [name, value] of Object.entries(parsed)) {
      values.set(name, value);
    }
  }

  const configuredValue = name =>
    Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : values.get(name);

  const isTrue = (name, fallback) => {
    const value = configuredValue(name);
    if (value === undefined) return fallback;
    return String(value).toLowerCase() === 'true';
  };

  const strictBoolean = (name, fallback) => {
    const value = configuredValue(name);
    if (value === undefined || String(value).trim() === '') return fallback;
    const normalizedValue = String(value).trim().toLowerCase();
    if (!['true', 'false'].includes(normalizedValue)) {
      throw new Error(`${name} must be either "true" or "false".`);
    }
    return normalizedValue === 'true';
  };

  const username = String(configuredValue('NOVAVENTA_USERNAME') || '').trim();
  const password = String(configuredValue('NOVAVENTA_PASSWORD') || '');
  const credentialsConfigured = Boolean(username && password);
  const requestedMode = String(configuredValue('NOVAVENTA_LOGIN_MODE') || '').trim().toLowerCase();

  if (requestedMode && !['auto', 'manual'].includes(requestedMode)) {
    throw new Error('NOVAVENTA_LOGIN_MODE must be either "auto" or "manual".');
  }

  let loginMode;
  let loginModeSource;
  if (requestedMode) {
    loginMode = requestedMode;
    loginModeSource = 'NOVAVENTA_LOGIN_MODE';
  } else {
    const legacyValue = configuredValue('NOVAVENTA_MANUAL_LOGIN');
    const hasLegacyValue = legacyValue !== undefined && String(legacyValue).trim() !== '';
    const normalizedLegacyValue = hasLegacyValue ? String(legacyValue).trim().toLowerCase() : '';
    if (hasLegacyValue && !['true', 'false'].includes(normalizedLegacyValue)) {
      throw new Error('NOVAVENTA_MANUAL_LOGIN must be either "true" or "false".');
    }

    if (hasLegacyValue) {
      loginMode = normalizedLegacyValue === 'true' ? 'manual' : 'auto';
      loginModeSource = 'NOVAVENTA_MANUAL_LOGIN';
    } else {
      loginMode = credentialsConfigured ? 'auto' : 'manual';
      loginModeSource = credentialsConfigured ? 'credentials' : 'fallback';
    }
  }

  return {
    loginMode,
    loginModeSource,
    manualLogin: loginMode === 'manual',
    loginOnly: strictBoolean('NOVAVENTA_LOGIN_ONLY', false),
    headless: isTrue('HEADLESS', false),
    debugLogs: isTrue('DEBUG_LOGS', true),
    credentialsConfigured,
  };
}

function acquireLock(filePath) {
  try {
    const descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(newLockRecord())}\n`);
    fs.closeSync(descriptor);
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const existing = readLock(filePath);
  const activePids = lockPids(existing).filter(processExists);
  if (activePids.length > 0) {
    throw new Error(`Another Novaventa run is active with PID(s) ${activePids.join(', ')}.`);
  }

  if (lockPids(existing).length === 0) {
    throw new Error(`A stale or invalid lock exists at ${filePath}; inspect it before removing it.`);
  }

  fs.unlinkSync(filePath);
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  fs.writeFileSync(descriptor, `${JSON.stringify(newLockRecord())}\n`);
  fs.closeSync(descriptor);
}

function newLockRecord() {
  return {
    ownerPid: process.pid,
    childPid: null,
    startedAt: new Date().toISOString(),
  };
}

function attachChildToLock(filePath, childPid) {
  if (!Number.isInteger(childPid) || childPid <= 0) return;

  const existing = readLock(filePath);
  if (existing?.ownerPid !== process.pid) {
    throw new Error('Lost ownership of the Novaventa run lock before the browser runner started.');
  }

  fs.writeFileSync(filePath, `${JSON.stringify({ ...existing, childPid })}\n`, { mode: 0o600 });
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function lockPids(lock) {
  if (!lock || typeof lock !== 'object') return [];
  return [...new Set([lock.ownerPid, lock.childPid, lock.pid])].filter(
    pid => Number.isInteger(pid) && pid > 0
  );
}

function releaseLock(filePath) {
  const existing = readLock(filePath);
  if (existing?.ownerPid === process.pid || existing?.pid === process.pid) {
    fs.unlinkSync(filePath);
  }
}

function waitForChild(childProcess) {
  return new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function appendOutput(current, chunk) {
  const maxCharacters = 4 * 1024 * 1024;
  const next = current + chunk.toString('utf8');
  return next.length > maxCharacters ? next.slice(-maxCharacters) : next;
}

function readStructuredReport(output) {
  const marker = 'NOVAVENTA_RUN_RESULT=';
  const lines = output.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const markerIndex = lines[index].indexOf(marker);
    if (markerIndex < 0) continue;
    try {
      return JSON.parse(lines[index].slice(markerIndex + marker.length));
    } catch {
      return null;
    }
  }
  return null;
}

function listRunDirectories(directoryPath) {
  if (!fs.existsSync(directoryPath)) return [];
  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('run-'))
    .map(entry => path.join(directoryPath, entry.name));
}

function findNewRunDirectory(directoryPath, previousRuns) {
  const candidates = listRunDirectories(directoryPath)
    .filter(runPath => !previousRuns.has(runPath))
    .map(runPath => ({ runPath, mtimeMs: fs.statSync(runPath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.runPath || null;
}

function readTerminalEvent(eventsPath) {
  if (!fs.existsSync(eventsPath)) return null;

  const lines = fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.event === 'run-end' || event.event === 'unexpected-error') return event;
    } catch {
      // Ignore a partially written diagnostic line and continue backwards.
    }
  }
  return null;
}
