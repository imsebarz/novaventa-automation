const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

dotenv.config({ path: path.join(__dirname, '.env') });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(
      info => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

const officeUrl = 'https://oficinavirtual.novaventa.com/';
const officeOrderUrl = new URL('/realizar-pedido', officeUrl).toString();
const storeUrl = 'https://novaventa.com/';
const screenshotsDir = path.join(__dirname, 'screenshots');
const productsFilePath = path.join(__dirname, 'products.json');
const configuredBrowserProfileDir = String(process.env.NOVAVENTA_BROWSER_PROFILE_DIR || '').trim();
const browserProfileDir = configuredBrowserProfileDir
  ? path.resolve(__dirname, configuredBrowserProfileDir)
  : path.join(__dirname, '.browser-profile-office');
const headless = String(process.env.HEADLESS || '').toLowerCase() === 'true';
const loginOnlyConfig = resolveOptionalBoolean(process.env, 'NOVAVENTA_LOGIN_ONLY', false);
const loginOnly = loginOnlyConfig.value;
const loginConfig = resolveLoginConfig(process.env);
const debugMode = String(process.env.DEBUG_LOGS ?? 'true').toLowerCase() !== 'false';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function resolveLoginConfig(env) {
  const username = String(env.NOVAVENTA_USERNAME || '').trim();
  const password = String(env.NOVAVENTA_PASSWORD || '');
  const credentialsConfigured = Boolean(username && password);
  const requestedMode = String(env.NOVAVENTA_LOGIN_MODE || '').trim().toLowerCase();

  if (requestedMode && !['auto', 'manual'].includes(requestedMode)) {
    return {
      mode: null,
      source: 'NOVAVENTA_LOGIN_MODE',
      credentialsConfigured,
      error: 'NOVAVENTA_LOGIN_MODE must be either "auto" or "manual".',
    };
  }

  if (requestedMode) {
    return {
      mode: requestedMode,
      source: 'NOVAVENTA_LOGIN_MODE',
      credentialsConfigured,
      error: null,
    };
  }

  const legacyValue = env.NOVAVENTA_MANUAL_LOGIN;
  if (legacyValue !== undefined && String(legacyValue).trim() !== '') {
    const normalizedLegacyValue = String(legacyValue).trim().toLowerCase();
    if (!['true', 'false'].includes(normalizedLegacyValue)) {
      return {
        mode: null,
        source: 'NOVAVENTA_MANUAL_LOGIN',
        credentialsConfigured,
        error: 'NOVAVENTA_MANUAL_LOGIN must be either "true" or "false".',
      };
    }

    return {
      mode: normalizedLegacyValue === 'true' ? 'manual' : 'auto',
      source: 'NOVAVENTA_MANUAL_LOGIN',
      credentialsConfigured,
      error: null,
    };
  }

  return {
    mode: credentialsConfigured ? 'auto' : 'manual',
    source: credentialsConfigured ? 'credentials' : 'fallback',
    credentialsConfigured,
    error: null,
  };
}

function resolveOptionalBoolean(env, name, fallback) {
  const rawValue = env[name];
  if (rawValue === undefined || String(rawValue).trim() === '') {
    return { value: fallback, error: null };
  }

  const normalizedValue = String(rawValue).trim().toLowerCase();
  if (!['true', 'false'].includes(normalizedValue)) {
    return { value: fallback, error: `${name} must be either "true" or "false".` };
  }

  return { value: normalizedValue === 'true', error: null };
}

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir);
}

// --- Debug logging --------------------------------------------------------
//
// When DEBUG_LOGS != "false" we record a per-run folder under logs/ that
// contains:
//   - run.log        : same lines we print to the console (winston file transport)
//   - events.jsonl   : structured JSON event per step (one line per event)
//   - html/<slug>/   : HTML snapshots of pages/cards/cart at key moments
//
// This makes it easy to diagnose products that say "did not increase cart
// quantity" or that report wrong quantities, without re-running the script.

const debug = createDebugLogger();

function createDebugLogger() {
  if (!debugMode) {
    return {
      runDir: null,
      record: () => {},
      saveHtml: async () => {},
      savePageHtml: async () => {},
      saveCardHtml: async () => {},
      saveCartHtml: async () => {},
    };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, 'logs', `run-${timestamp}`);
  const htmlDir = path.join(runDir, 'html');
  fs.mkdirSync(htmlDir, { recursive: true });

  const eventsPath = path.join(runDir, 'events.jsonl');
  const runLogPath = path.join(runDir, 'run.log');

  // Also pipe winston INFO/WARN/ERROR lines to a file inside the run dir.
  logger.add(
    new winston.transports.File({
      filename: runLogPath,
      level: 'info',
    })
  );

  const safe = value => String(value || 'misc').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);

  function record(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(eventsPath, line + '\n');
  }

  async function saveHtml(filename, html) {
    const fullPath = path.join(htmlDir, filename);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, html ?? '');
    return fullPath;
  }

  async function savePageHtml(page, slug) {
    try {
      const html = await page.content();
      return saveHtml(`${safe(slug)}.html`, html);
    } catch (error) {
      record({ event: 'savePageHtml-error', slug, error: error.message });
      return null;
    }
  }

  async function saveCardHtml(page, productCode, slug) {
    try {
      const html = await page.evaluate(code => {
        const cards = [
          ...document.querySelectorAll(
            '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
          ),
        ];
        const exactCl = new RegExp(`^CL:\\s*${code}(?!\\d)`, 'i');
        const card = cards.find(element =>
          [...element.querySelectorAll('[class*="__cl"], label')].some(node =>
            exactCl.test((node.textContent || '').trim())
          )
        );
        return card ? card.outerHTML : null;
      }, productCode);

      if (!html) {
        record({ event: 'saveCardHtml-no-card', code: productCode, slug });
        return null;
      }
      return saveHtml(`${safe(productCode)}/${safe(slug)}.html`, html);
    } catch (error) {
      record({ event: 'saveCardHtml-error', code: productCode, slug, error: error.message });
      return null;
    }
  }

  async function saveCartHtml(page, slug) {
    try {
      const html = await page.evaluate(() => {
        const candidates = [
          '[data-testid="carrito-badge"]',
          'aside[class*="carrito"]',
          '[class*="carrito-popover"]',
          '[class*="carrito-container"]',
          '[class*="modal"][class*="active"]',
          '[class*="cart-drawer"]',
          '[class*="mini-cart"]',
          '[class*="cart-panel"]',
          '[class*="pedido"]',
        ];
        const found = [];
        const seen = new Set();
        for (const selector of candidates) {
          for (const element of document.querySelectorAll(selector)) {
            if (seen.has(element)) continue;
            seen.add(element);
            found.push(`<!-- selector: ${selector} -->\n${element.outerHTML}`);
            if (found.length >= 8) return found.join('\n\n');
          }
        }
        return found.join('\n\n');
      });
      return saveHtml(`cart/${safe(slug)}.html`, html);
    } catch (error) {
      record({ event: 'saveCartHtml-error', slug, error: error.message });
      return null;
    }
  }

  return { runDir, record, saveHtml, savePageHtml, saveCardHtml, saveCartHtml };
}

function loadProducts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Products file not found: ${filePath}`);
  }

  const products = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('Products file must contain a non-empty array.');
  }

  return products.map((product, index) => {
    const code = product.code?.toString().trim();
    const quantity = Number(product.quantity ?? 1);

    if (!code) {
      throw new Error(`Product at position ${index + 1} is missing a code.`);
    }

    if (!/^\d+$/.test(code)) {
      throw new Error(`Product code must contain only digits: ${code}`);
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Product ${code} has an invalid quantity: ${product.quantity}`);
    }

    return { code, quantity };
  });
}

(async () => {
  const products = loadProducts(productsFilePath);
  logger.info(`Loaded ${products.length} products from ${productsFilePath}.`);
  if (debug.runDir) {
    logger.info(`Debug logs enabled: ${debug.runDir}`);
  }
  debug.record({ event: 'run-start', productCount: products.length, products });

  const successfulProducts = [];
  const errorProducts = [];

  const browser = await puppeteer.launch({
    headless,
    userDataDir: browserProfileDir,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.setViewport({ width: 1366, height: 900 });

  // Track every navigation so we can correlate timeouts with URLs in the events log.
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      debug.record({ event: 'navigation', url: frame.url() });
    }
  });
  page.on('pageerror', error => {
    debug.record({ event: 'pageerror', message: error.message });
  });
  page.on('requestfailed', request => {
    debug.record({ event: 'requestfailed', url: request.url(), reason: request.failure()?.errorText });
  });

  try {
    if (loginOnlyConfig.error) {
      throw new Error(loginOnlyConfig.error);
    }

    await loginOfficeVirtual(page);
    await chooseOfficeVirtualModeIfPrompted(page);
    await debug.savePageHtml(page, 'after-login');

    if (loginOnly) {
      const loginResult = {
        event: 'login-check',
        authenticated: true,
        loginMode: loginConfig.mode,
        loginModeSource: loginConfig.source,
      };
      debug.record(loginResult);
      logger.info('Login-only check completed; the cart was not opened or changed.');
      logger.info(`NOVAVENTA_RUN_RESULT=${JSON.stringify(loginResult)}`);
      return;
    }

    await clearCart(page);
    await debug.savePageHtml(page, 'after-clear-cart');

    for (const product of products) {
      const { code, quantity } = product;
      debug.record({ event: 'product-start', code, quantity });

      // Long pedidos can outlive the site's idle-session timer. Dismiss the
      // "Sesión inactiva" modal proactively before each product so it never
      // blocks our clicks mid-flow.
      await dismissSessionTimeoutModal(page);

      try {
        const productInfo = await searchProduct(page, code);

        if (!productInfo) {
          logger.warn(`Product code ${code} not found.`);
          errorProducts.push({ code, error: 'Product not found' });
          await takeScreenshot(page, `not_found_${code}.png`);
          await debug.savePageHtml(page, `${code}/search-not-found`);
          debug.record({ event: 'product-not-found', code });
          continue;
        }

        debug.record({ event: 'product-found', code, info: productInfo });
        const addResult = await addToCart(page, productInfo, quantity);
        const addedQuantity = typeof addResult === 'number' ? addResult : addResult.added;
        const failureReason = typeof addResult === 'number' ? '' : (addResult.reason || '');

        if (addedQuantity > 0) {
          successfulProducts.push({ ...productInfo, quantity: addedQuantity });
        }

        if (addedQuantity < quantity) {
          const baseMsg =
            addedQuantity === 0
              ? `Not added (0 of ${quantity})`
              : `Only added ${addedQuantity} of ${quantity} requested`;
          errorProducts.push({
            code,
            name: productInfo.name || '',
            error: failureReason ? `${baseMsg} — ${failureReason}` : baseMsg,
          });
          await takeScreenshot(page, `partial_or_failed_add_${code}.png`);
          await debug.savePageHtml(page, `${code}/after-failed-add`);
          await debug.saveCardHtml(page, code, 'card-after-failed-add');
          await debug.saveCartHtml(page, `${code}-after-failed-add`);
        }
        debug.record({ event: 'product-done', code, requested: quantity, added: addedQuantity, reason: failureReason });
      } catch (productError) {
        logger.error(`Error processing product ${code}: ${productError.message}`);
        errorProducts.push({ code, error: productError.message });
        await takeScreenshot(page, `error_${code}.png`);
        await debug.savePageHtml(page, `${code}/exception`);
        debug.record({ event: 'product-exception', code, message: productError.message, stack: productError.stack });
      }
    }

    // The header badge alone cannot prove which CL owns each unit, and the
    // transient "Cantidad agregada" toast is not authoritative. Reconcile the complete
    // run against the real cart drawer before reporting success.
    const cartState = await getCartState(page);
    const reconciled = reconcileRunResults(
      products,
      successfulProducts,
      errorProducts,
      cartState
    );
    await outputSummary(reconciled.successfulProducts, reconciled.errorProducts);
    const finalSummary = formatCartSummary(cartState);
    logger.info(`Cart total: ${finalSummary}`);
    const runResult = {
      event: 'run-end',
      requestedEntryCount: products.length,
      requestedSkuCount: new Set(products.map(product => product.code)).size,
      requestedUnitCount: products.reduce((sum, product) => sum + product.quantity, 0),
      successCount: reconciled.successfulProducts.length,
      errorCount: reconciled.errorProducts.length,
      addedSkuCount: cartState.authoritative ? cartState.items.length : null,
      addedUnitCount: cartState.authoritative ? cartState.unitCount : null,
      cartSummary: finalSummary,
      cartState,
      successfulProducts: reconciled.successfulProducts,
      errorProducts: reconciled.errorProducts,
    };
    debug.record(runResult);
    logger.info(`NOVAVENTA_RUN_RESULT=${JSON.stringify(runResult)}`);
    await debug.savePageHtml(page, 'final');
  } catch (error) {
    logger.error(`An unexpected error occurred: ${error.message}`);
    const failureResult = {
      event: 'unexpected-error',
      message: error.message,
      successCount: successfulProducts.length,
      errorCount: errorProducts.length,
      successfulProducts,
      errorProducts,
    };
    logger.error(`NOVAVENTA_RUN_RESULT=${JSON.stringify(failureResult)}`);
    debug.record({ ...failureResult, stack: error.stack });
    await clearSensitiveLoginInputs(page);
    await takeScreenshot(page, 'unexpected_error.png');
    await debug.savePageHtml(page, 'unexpected-error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

async function loginOfficeVirtual(page) {
  if (loginConfig.error) {
    throw new Error(loginConfig.error);
  }

  const username = String(process.env.NOVAVENTA_USERNAME || '').trim();
  const password = String(process.env.NOVAVENTA_PASSWORD || '');

  logger.info(`Opening Oficina Virtual (login mode: ${loginConfig.mode}).`);
  await gotoOfficeHome(page);

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Existing Oficina Virtual session detected.');
    return;
  }

  // Wait briefly for the SPA to render the login form (the page renders
  // either the form or the "Inicia sesión desde Tienda Virtual" CTA).
  await waitForLoginFormOrSession(page);

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Oficina Virtual session detected after page render.');
    return;
  }

  if (loginConfig.mode === 'manual') {
    await waitForManualOfficeLogin(page);
    return;
  }

  if (!username || !password) {
    throw new Error(
      'Automatic login needs both NOVAVENTA_USERNAME and NOVAVENTA_PASSWORD in .env. ' +
      'Set NOVAVENTA_LOGIN_MODE=manual to log in interactively.'
    );
  }

  await page.waitForSelector('form input[type="password"]', {
    visible: true,
    timeout: 60000,
  });

  await typeIntoLoginInput(page, 'username', username);
  await typeIntoLoginInput(page, 'password', password);

  logger.info('Submitting Oficina Virtual credentials.');
  const loginResponsePromise = page
    .waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        /\/login\/comercio(?:[/?]|$)/i.test(response.url()),
      { timeout: 45000 }
    )
    .then(response => ({ type: 'response', response }))
    .catch(() => null);
  const recaptchaChallengePromise = waitForVisibleRecaptchaChallenge(page, 45000)
    .then(found => found ? { type: 'recaptcha', response: null } : null);

  await clickLoginSubmit(page);
  const firstLoginOutcome = await Promise.race([loginResponsePromise, recaptchaChallengePromise]);
  if (firstLoginOutcome?.type === 'recaptcha') {
    const recaptchaError = 'Oficina Virtual requires reCAPTCHA validation; manual login is needed for this session.';
    if (await continueWithManualRecaptcha(page, recaptchaError)) return;
    throw new Error(recaptchaError);
  }

  const loginResponse = firstLoginOutcome?.response || null;
  if (!loginResponse) {
    const recaptchaError = await hasVisibleRecaptchaChallenge(page)
      ? 'Oficina Virtual requires reCAPTCHA validation; manual login is needed for this session.'
      : '';
    if (recaptchaError) {
      if (await continueWithManualRecaptcha(page, recaptchaError)) return;
      throw new Error(recaptchaError);
    }
    throw new Error('Oficina Virtual did not return a response from the automatic login endpoint.');
  }
  debug.record({ event: 'login-response', status: loginResponse.status() });
  await waitForLoginOutcome(page);

  if (!page.url().startsWith(officeUrl)) {
    logger.warn(`Oficina Virtual redirected outside office flow after login: ${page.url()}`);
    await gotoOfficeHome(page);
  }

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Logged in to Oficina Virtual.');
    return;
  }

  const bodyText = await getVisibleText(page);
  const loginError = extractLoginError(bodyText);
  const requiresManualChallenge =
    (Boolean(loginError) && /recaptcha/i.test(loginError)) ||
    await hasVisibleRecaptchaChallenge(page);

  if (requiresManualChallenge) {
    const recaptchaError = loginError || 'Oficina Virtual requires reCAPTCHA validation; manual login is needed for this session.';
    if (await continueWithManualRecaptcha(page, recaptchaError)) return;
    throw new Error(recaptchaError);
  }

  const statusSuffix = loginResponse.status() >= 400 ? ` (HTTP ${loginResponse.status()})` : '';
  throw new Error(loginError || `Could not log in to Oficina Virtual${statusSuffix}.`);
}

async function waitForManualOfficeLogin(page) {
  logger.info('Manual login mode enabled.');
  logger.info('Inicia sesión con cédula + contraseña directamente en la ventana del navegador.');
  logger.info('Si solo ves el botón "Inicia sesión desde Tienda Virtual", recarga o usa ese flujo.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('\nCuando estés dentro de Oficina Virtual (con catálogo/carrito visible), presiona ENTER aquí para continuar... ');
  } finally {
    rl.close();
  }

  if (!page.url().startsWith(officeUrl)) {
    logger.info('La pestaña actual no está en Oficina Virtual; abriendo la home con la sesión existente.');
    await gotoOfficeHome(page);
  }

  await sleep(3000);

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Manual Oficina Virtual session detected. Continuing with products.');
    return;
  }

  throw new Error('No se detectó el login manual. Asegúrate de estar dentro de Oficina Virtual antes de presionar ENTER.');
}

async function gotoOfficeHome(page) {
  await page.goto(officeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
    logger.warn(`Navigation did not finish cleanly, continuing with loaded DOM: ${error.message}`);
  });
  await sleep(6000);
}

// Backwards-compatible alias for code paths that used to navigate to /realizar-pedido.
async function gotoOfficeOrder(page) {
  await gotoOfficeHome(page);
}

async function waitForLoginFormOrSession(page) {
  try {
    await page.waitForFunction(
      () => {
        const isVisible = element => {
          const rect = element?.getBoundingClientRect();
          const style = element ? getComputedStyle(element) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const hasPasswordInput = [...document.querySelectorAll('form input[type="password"]')].some(isVisible);
        const hasAuthenticatedShell =
          isVisible(document.querySelector('[data-testid="buscador-input"]')) &&
          isVisible(document.querySelector('[data-testid="carrito-badge"]'));
        const text = document.body?.innerText || '';
        const showsAuthenticatedModePrompt = /Elige cómo prefieres comprar|Haz tu pedido en\s*oficina virtual/i.test(text);
        const showsTiendaFallback = /Inicia sesión desde Tienda Virtual/i.test(text);
        return hasPasswordInput || hasAuthenticatedShell || showsAuthenticatedModePrompt || showsTiendaFallback;
      },
      { timeout: 45000 }
    );
  } catch (error) {
    logger.warn(`Did not find login form or session indicator: ${error.message}`);
  }
}

async function clickLoginSubmit(page) {
  const clicked = await page.evaluate(() => {
    const form = [...document.querySelectorAll('form')].find(candidate =>
      candidate.querySelector('input[type="password"]')
    );
    const submit =
      form?.querySelector('button[type="submit"]') ||
      [...(form?.querySelectorAll('button') || [])].find(button =>
        /Inicia(?:r)?\s+sesión/i.test(button.textContent || '')
      );

    if (!submit) return false;
    submit.scrollIntoView({ block: 'center' });
    submit.click();
    return true;
  });

  if (!clicked) {
    throw new Error('Login submit button was not found inside the Oficina Virtual credential form.');
  }
}

async function isLoggedInOfficeVirtual(page) {
  const url = page.url();
  if (!url.startsWith(officeUrl)) return false;

  return page.evaluate(() => {
    const isVisible = element => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const hasVisibleLoginForm = [...document.querySelectorAll('form input[type="password"]')].some(isVisible);
    if (hasVisibleLoginForm) return false;

    const hasAuthenticatedShell =
      isVisible(document.querySelector('[data-testid="buscador-input"]')) &&
      isVisible(document.querySelector('[data-testid="carrito-badge"]'));
    const text = document.body?.innerText || '';
    const showsAuthenticatedModePrompt = /Elige cómo prefieres comprar|Haz tu pedido en\s*oficina virtual/i.test(text);
    return hasAuthenticatedShell || showsAuthenticatedModePrompt;
  }).catch(() => false);
}

async function waitForLoginOutcome(page) {
  try {
    await page.waitForFunction(
      () => {
        const isVisible = element => {
          const rect = element?.getBoundingClientRect();
          const style = element ? getComputedStyle(element) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const hasAuthenticatedShell =
          isVisible(document.querySelector('[data-testid="buscador-input"]')) &&
          isVisible(document.querySelector('[data-testid="carrito-badge"]'));
        const text = document.body?.innerText || '';
        const hasModePrompt = /Elige cómo prefieres comprar|Haz tu pedido en\s*oficina virtual/i.test(text);
        const hasLoginError = /Usuario o contraseña son incorrectos|reCAPTCHA|captcha/i.test(text);
        const hasVisibleChallenge = [...document.querySelectorAll('iframe[src*="recaptcha" i], .g-recaptcha, [data-sitekey]')]
          .some(isVisible);
        return hasAuthenticatedShell || hasModePrompt || hasLoginError || hasVisibleChallenge;
      },
      { timeout: 20000 }
    );
  } catch (error) {
    logger.warn(`Login endpoint responded but the page did not expose a recognized outcome: ${error.message}`);
  }
  await sleep(1000);
}

async function hasVisibleRecaptchaChallenge(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
    };
    const text = document.body?.innerText || '';
    if (/reCAPTCHA|captcha/i.test(text)) return true;
    return [...document.querySelectorAll('iframe[src*="recaptcha" i], .g-recaptcha, [data-sitekey]')]
      .some(isVisible);
  }).catch(() => false);
}

async function waitForVisibleRecaptchaChallenge(page, timeout) {
  try {
    await page.waitForFunction(
      () => {
        const isVisible = element => {
          const rect = element?.getBoundingClientRect();
          const style = element ? getComputedStyle(element) : null;
          return !!rect && rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
        };
        const text = document.body?.innerText || '';
        if (/reCAPTCHA|captcha/i.test(text)) return true;
        return [...document.querySelectorAll('iframe[src*="recaptcha" i], .g-recaptcha, [data-sitekey]')]
          .some(isVisible);
      },
      { timeout }
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function continueWithManualRecaptcha(page, errorMessage) {
  if (!process.stdin.isTTY || headless) return false;
  logger.warn(`${errorMessage || 'Oficina Virtual requires reCAPTCHA validation.'} Complete it in the open browser to continue.`);
  await waitForManualOfficeLogin(page);
  return true;
}

async function clearSensitiveLoginInputs(page) {
  await page.evaluate(() => {
    const selector = [
      'form input[type="password"]',
      'form [data-testid="input-text"]',
      'form input[autocomplete="username"]',
      'form input[type="text"]',
      'form input[type="tel"]',
      'form input[type="number"]',
    ].join(', ');
    for (const input of document.querySelectorAll(selector)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, '');
      else input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }).catch(() => {});
}

async function typeIntoLoginInput(page, kind, value) {
  await page.waitForFunction(
    inputKind => {
      const isVisible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const forms = [...document.querySelectorAll('form')];
      const form = forms.find(candidate => candidate.querySelector('input[type="password"]'));
      if (!form) return false;
      return [...form.querySelectorAll('input')].some(input => {
        if (!isVisible(input) || input.disabled) return false;
        return inputKind === 'password'
          ? input.type === 'password'
          : !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio'].includes(input.type);
      });
    },
    { timeout: 30000 },
    kind
  );

  await page.evaluate(
    (inputKind, inputValue) => {
      const isVisible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const forms = [...document.querySelectorAll('form')];
      const form = forms.find(candidate => candidate.querySelector('input[type="password"]'));
      const candidates = [...(form?.querySelectorAll('input') || [])].filter(input => {
        if (!isVisible(input) || input.disabled) return false;
        return inputKind === 'password'
          ? input.type === 'password'
          : !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio'].includes(input.type);
      });

      const scoreUsernameInput = input => {
        const attributes = [
          input.getAttribute('data-testid'),
          input.name,
          input.id,
          input.placeholder,
          input.autocomplete,
          input.getAttribute('aria-label'),
        ].join(' ');
        let score = 0;
        if (input.getAttribute('data-testid') === 'input-text') score += 1000;
        if (/username/i.test(input.autocomplete || '')) score += 100;
        if (/c[eé]dula|documento|usuario|identificaci[oó]n|1234567890/i.test(attributes)) score += 50;
        if (['text', 'tel', 'number'].includes(input.type)) score += 10;
        return score;
      };

      const input = inputKind === 'password'
        ? candidates.find(candidate => candidate.getAttribute('data-testid') === 'input-password') || candidates[0]
        : candidates.sort((left, right) => scoreUsernameInput(right) - scoreUsernameInput(left))[0];

      if (!input) throw new Error(`Visible ${inputKind} input not found in the login form.`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, inputValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    kind,
    value
  );
}

function extractLoginError(bodyText) {
  if (/Usuario o contraseña son incorrectos/i.test(bodyText)) {
    return 'Oficina Virtual rejected the configured credentials: Usuario o contraseña son incorrectos.';
  }

  if (/reCAPTCHA|captcha/i.test(bodyText)) {
    return 'Oficina Virtual requires reCAPTCHA validation; manual login is needed for this session.';
  }

  return '';
}

async function chooseOfficeVirtualModeIfPrompted(page) {
  const text = await getVisibleText(page);

  if (!/Elige cómo prefieres comprar|Haz tu pedido en\s*oficina virtual/i.test(text)) {
    return;
  }

  logger.info('Choosing Oficina Virtual mode.');
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('a, button')];
    const target = candidates.find(element => /oficina virtual/i.test(element.textContent || ''));
    target?.click();
  });
  await sleep(3000);
}

async function clearCart(page) {
  logger.info('Clearing Oficina Virtual cart before adding products.');
  await ensureOfficeHome(page);

  // IMPORTANT: never trust the header badge before the cart panel is open.
  // The badge often reads "" / 0 on a fresh page load and only updates after
  // the user opens the cart. We always open the panel and then count visible
  // delete buttons (or read the badge after settle) to decide whether to skip.
  const cartOpened = await openCartIfNeeded(page);
  await sleep(1500);

  let currentCount = await getCartItemCount(page);
  const visibleDeleteCount = await countVisibleDeleteButtons(page);
  const explicitlyEmpty = await isCartExplicitlyEmpty(page);
  debug.record({ event: 'clear-cart-initial', currentCount, visibleDeleteCount, explicitlyEmpty, cartOpened });

  if (explicitlyEmpty) {
    logger.info('Cart already empty.');
    return;
  }
  if (!cartOpened || (!(await isCartPanelOpen(page)) && visibleDeleteCount === 0)) {
    throw new Error('Could not confirm that the cart panel opened; refusing to assume the cart is empty.');
  }
  logger.info(`Cart has ${currentCount || visibleDeleteCount} items, clearing...`);

  // The cart panel can be dismissed mid-loop. Re-open it when needed and only
  // declare completion after the drawer shows its explicit empty state.
  let consecutiveReopens = 0;
  const maxReopens = 8;

  for (let attempt = 1; attempt <= 200; attempt += 1) {
    // The idle-session modal can pop while we are still deleting. Always dismiss
    // it first so it can't intercept our delete clicks.
    await dismissSessionTimeoutModal(page);

    currentCount = await getCartItemCount(page);
    const remainingDeleteButtons = await countVisibleDeleteButtons(page);
    debug.record({ event: 'clear-cart-iteration', attempt, currentCount, remainingDeleteButtons });

    if (remainingDeleteButtons === 0 && (await isCartExplicitlyEmpty(page))) {
      logger.info('Cart cleared.');
      return;
    }

    const panelOpen = await isCartPanelOpen(page);
    if (!panelOpen) {
      consecutiveReopens += 1;
      if (consecutiveReopens > maxReopens) {
        await debug.saveCartHtml(page, `clear-cart-reopen-fail-${attempt}`);
        throw new Error(
          `Cart panel keeps closing and ${currentCount} items remain. Aborting clearCart.`
        );
      }
      logger.info(`Cart panel is closed; reopening (count=${currentCount}, reopen=${consecutiveReopens}).`);
      debug.record({ event: 'clear-cart-reopen', attempt, currentCount, consecutiveReopens });
      await openCartIfNeeded(page);
      continue;
    }

    consecutiveReopens = 0;

    const cartChangePromise = page
      .waitForResponse(
        response =>
          /carrito|pedido|cart/i.test(response.url()) &&
          response.status() >= 200 &&
          response.status() < 300,
        { timeout: 15000 }
      )
      .catch(() => null);

    const clicked = await page.evaluate(() => {
      const isVisible = element => {
        const rect = element?.getBoundingClientRect();
        return !!rect && rect.width > 0 && rect.height > 0;
      };
      const root = [
        ...document.querySelectorAll('[class*="carrito-popover"], [class*="carrito-container"], aside[class*="carrito"]'),
      ].find(isVisible);
      if (!root) return false;
      const selectors = [
        'button[class*="producto-carrito-eliminar-button"]',
        '[data-testid*="eliminar"]',
        '[data-testid*="trash"]',
        '[data-testid*="delete"]',
        'button[class*="eliminar"]',
        'button[class*="trash"]',
        'button[aria-label*="eliminar" i]',
        'button[aria-label*="quitar" i]',
      ];

      for (const selector of selectors) {
        const button = root.querySelector(selector);
        if (button && isVisible(button)) {
          button.scrollIntoView({ block: 'center' });
          button.click();
          return true;
        }
      }

      const trashButton = [...root.querySelectorAll('button')].find(button => {
        if (!isVisible(button)) return false;
        const haystack = (button.textContent || '') + ' ' + (button.getAttribute('aria-label') || '');
        return /eliminar|borrar|quitar|remove|trash/i.test(haystack);
      });
      if (!trashButton) return false;

      trashButton.scrollIntoView({ block: 'center' });
      trashButton.click();
      return true;

    });

    if (!clicked) {
      // Either the panel closed or there really are no delete buttons. Force a reopen
      // and retry on the next iteration; isCartPanelOpen above will catch a permanent
      // closure via the consecutiveReopens cap.
      debug.record({ event: 'clear-cart-no-delete-button', attempt, currentCount });
      await openCartIfNeeded(page);
      await sleep(800);
      continue;
    }

    await cartChangePromise;

    await sleep(1200);
  }

  throw new Error(`Could not clear cart after 200 iterations. Items still in cart: ${await getCartItemCount(page)}`);
}

// Detect the "Sesión inactiva / Tu sesión se cerrará pronto" warning modal and
// click "Continuar" to keep the session alive. Safe to call as often as needed —
// it's a no-op when the modal isn't visible.
async function dismissSessionTimeoutModal(page) {
  const dismissed = await page.evaluate(() => {
    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const bodyText = document.body?.innerText || '';
    if (!/Sesión inactiva|Tu sesión se cerrará pronto|cerraremos sesión por inactividad/i.test(bodyText)) {
      return false;
    }

    const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
    const continuar = buttons.find(button => {
      if (!isVisible(button)) return false;
      const label = (button.textContent || '').trim();
      return /^\s*Continuar\s*$/i.test(label);
    });

    if (!continuar) return false;

    continuar.scrollIntoView({ block: 'center' });
    continuar.click();
    return true;
  });

  if (dismissed) {
    logger.info('Dismissed "Sesión inactiva" modal (clicked Continuar).');
    debug.record({ event: 'session-modal-dismissed' });
    await sleep(1500);
  }
  return dismissed;
}

async function countVisibleDeleteButtons(page) {
  return page.evaluate(() => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const root = [
      ...document.querySelectorAll('[class*="carrito-popover"], [class*="carrito-container"], aside[class*="carrito"]'),
    ].find(isVisible);
    if (!root) return 0;
    const seen = new Set();
    const selectors = [
      'button[class*="producto-carrito-eliminar-button"]',
      '[data-testid*="eliminar"]',
      '[data-testid*="trash"]',
      '[data-testid*="delete"]',
      'button[class*="eliminar"]',
      'button[class*="trash"]',
      'button[aria-label*="eliminar" i]',
      'button[aria-label*="quitar" i]',
    ];
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        if (isVisible(element)) seen.add(element);
      }
    }
    return seen.size;
  });
}

async function isCartExplicitlyEmpty(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = [
      ...document.querySelectorAll('[class*="carrito-popover"], [class*="carrito-container"], aside[class*="carrito"]'),
    ].find(isVisible);
    if (!root) return false;
    return /Aún no tienes artículos|Carrito vacío/i.test(root.innerText || '');
  });
}

async function isCartPanelOpen(page) {
  return page.evaluate(() => {
    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const drawerCandidates = [
      'aside[class*="carrito"]',
      '[class*="carrito-popover"]',
      '[class*="carrito-container"]',
      '[class*="cart-drawer"]',
      '[class*="cart-panel"]',
      '[class*="mini-cart"]',
    ];
    for (const selector of drawerCandidates) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)) return true;
      }
    }

    return false;
  });
}

async function ensureOfficeHome(page) {
  if (!page.url().startsWith(officeUrl)) {
    await gotoOfficeHome(page);
  }
}

async function openCartIfNeeded(page) {
  if (await isCartPanelOpen(page)) {
    return true;
  }

  // Click the cart badge to open the drawer/panel.
  const opened = await page.evaluate(() => {
    const badge =
      document.querySelector('[data-testid="carrito-badge"]') ||
      document.querySelector('[class*="carrito-interact-zone"]') ||
      document.querySelector('[class*="carrito"]');
    if (!badge) return false;
    badge.scrollIntoView({ block: 'center' });
    const clickable =
      badge.closest('button, a, [role="button"]') ||
      badge.querySelector('button, a, [role="button"]') ||
      badge;
    clickable.click();
    return true;
  });

  if (!opened) {
    logger.warn('Cart badge not found; cart panel may not open.');
  }
  await sleep(2000);
  return opened && (await isCartPanelOpen(page));
}

async function searchProduct(page, code) {
  logger.info(`Searching for product code: ${code}`);
  debug.record({ event: 'search-start', code });

  await ensureOfficeHome(page);
  const searchApiResponsePromise = waitForProductSearchResponse(page, code, 60000);

  const searchUrl = new URL('/BUSQUEDA', officeUrl);
  searchUrl.searchParams.set('query', code);
  searchUrl.searchParams.set('page', '1');
  searchUrl.searchParams.set('pageSize', '36');
  searchUrl.searchParams.set('modoProductosInfinitos', 'true');
  await page.goto(searchUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
    logger.warn(`Search navigation did not finish cleanly, continuing with loaded DOM: ${error.message}`);
    debug.record({ event: 'search-nav-timeout', code, error: error.message });
  });

  // Wait for ONE of: the actual product card with the code we searched, an
  // explicit "no results" header, or a result count header (1+ resultados). The
  // empty container alone is NOT enough — it appears before cards finish loading
  // and was the cause of the intermittent "Product not found" false negatives.
  try {
    await page.waitForFunction(
      searchedCode => {
        const text = document.body.innerText || '';
        if (new RegExp(`(^|\\n)CL:\\s*${searchedCode}(?:\\n|$)`, 'i').test(text)) return true;

        // Explicit "no results" wording (varies depending on locale).
        if (/¡?No hay resultados!?|sin resultados|no encontramos|No encontramos|0 resultados/i.test(text)) {
          return true;
        }

        // Number of results header — only trust it once at least one card is rendered.
        const resultsHeaderMatch = text.match(/(\d+)\s*resultados?/i);
        const cardCount = document.querySelectorAll('[class*="product-item-card"]').length;
        if (resultsHeaderMatch) {
          const expected = Number(resultsHeaderMatch[1]);
          if (expected === 0) return true;
          if (cardCount > 0) return true;
        }

        return false;
      },
      { timeout: 60000 },
      code
    );
  } catch (error) {
    debug.record({ event: 'search-wait-timeout', code, error: error.message });
    await debug.savePageHtml(page, `${code}/search-wait-timeout`);
  }

  // Small grace period so the React product card finishes mounting.
  await sleep(1500);

  // Dismiss the inactivity modal if it appeared during the search (it blocks clicks).
  await dismissSessionTimeoutModal(page);

  // Retry once if we have a results header but the card for our code didn't render.
  const needsRetry = await page.evaluate(searchedCode => {
    const text = document.body.innerText || '';
    if (new RegExp(`(^|\\n)CL:\\s*${searchedCode}(?:\\n|$)`, 'i').test(text)) return false;
    const cardCount = document.querySelectorAll('[class*="product-item-card"]').length;
    const headerMatch = text.match(/(\d+)\s*resultados?/i);
    const explicitNoResults = /¡?No hay resultados!?|0 resultados|sin resultados|no encontramos/i.test(text);
    if (explicitNoResults) return false;
    // If header says ≥1 results but we have no cards yet, retry.
    if (headerMatch && Number(headerMatch[1]) >= 1 && cardCount === 0) return true;
    // If header is missing entirely, retry.
    if (!headerMatch && !explicitNoResults) return true;
    return false;
  }, code);

  if (needsRetry) {
    debug.record({ event: 'search-retry', code });
    logger.info(`Search results for ${code} did not render fully; retrying once.`);
    await sleep(2500);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3500);
  }

  await debug.savePageHtml(page, `${code}/search-results`);
  await debug.saveCardHtml(page, code, 'card-found');

  // Snapshot the "header line" of search results so we can compare "1 resultados" vs "0 resultados".
  const resultsHeader = await page.evaluate(() => {
    const text = document.body.innerText.split('\n').map(line => line.trim()).filter(Boolean);
    const headerIdx = text.findIndex(line => /resultados|sin resultados|no encontramos/i.test(line));
    return {
      header: headerIdx >= 0 ? text[headerIdx] : '',
      cardCount: document.querySelectorAll('[class*="product-item-card"]').length,
    };
  });
  debug.record({ event: 'search-results-header', code, ...resultsHeader });

  const productInfo = await page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
      ),
    ];
    const exactCl = new RegExp(`^CL:\\s*${searchedCode}(?!\\d)`, 'i');
    const card = cards.find(element =>
      [...element.querySelectorAll('[class*="__cl"], label')].some(node =>
        exactCl.test((node.textContent || '').trim())
      )
    );

    if (!card) return null;

    const buttons = [...card.querySelectorAll('button')];
    const addButton = buttons.find(button => /^\s*Agregar\s*$/i.test(button.textContent || ''));
    const variantButton = buttons.find(button =>
      /^\s*Elegir\s+(tono|color|talla|opci[oó]n)\s*$/i.test(button.textContent || '')
    );
    const productLink = card.querySelector('a[href*="/p"]');

    // Prefer the dedicated CSS-module classes — they always hold the clean product data.
    const descriptionEl = card.querySelector('[class*="details_details__descripcion"]');
    const marcaEl = card.querySelector('[class*="details_details__marca"]');
    const priceEl = card.querySelector('[class*="precio-mas-iva__precio"], [class*="precio-final"], [class*="details_details__precio"]');

    const productImage = card.querySelector('img[alt]');
    const imageAlt = productImage?.getAttribute('alt')?.trim() || '';

    // Fallback: parse the line immediately before "CL: <code>" in the card text.
    const cardLines = (card.innerText || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const clLineIndex = cardLines.findIndex(line => new RegExp(`CL:\\s*${searchedCode}\\b`).test(line));
    const nameFromText = clLineIndex > 0 ? cardLines[clLineIndex - 1] : '';
    const brandFromText = clLineIndex > 1 ? cardLines[clLineIndex - 2] : '';
    const priceLine = cardLines.find(line => /^\$[\d.,]+/.test(line)) || '';

    const baseInfo = {
      code: searchedCode,
      name: descriptionEl?.textContent.trim().replace(/\s+/g, ' ') || imageAlt || nameFromText || '',
      brand: marcaEl?.textContent.trim().replace(/\s+/g, ' ') || brandFromText || '',
      price: priceEl?.textContent.trim().replace(/\s+/g, ' ') || priceLine || '',
    };

    if (addButton && !addButton.disabled) {
      return { ...baseInfo, canAdd: true, actionType: 'add' };
    }

    if (variantButton && !variantButton.disabled && productLink?.getAttribute('href')) {
      return {
        ...baseInfo,
        canAdd: true,
        actionType: 'select-variant',
        pdpPath: productLink.getAttribute('href'),
        variantLabel: variantButton.textContent.trim().replace(/\s+/g, ' '),
      };
    }

    {
      const warning = getVisibleText(
        card,
        '[data-testid="product-warning"], [class*="warning"], [class*="aviso"], [class*="agotado"], [class*="alert--on"]'
      );
      const primaryAction = buttons.find(button => isVisible(button) && !button.disabled && (button.innerText || '').trim());
      return {
        ...baseInfo,
        canAdd: false,
        actionType: 'unavailable',
        unavailableReason: warning || primaryAction?.innerText.trim() || 'Add button not found',
      };
    }

    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function getVisibleText(root, selector) {
      const element = [...root.querySelectorAll(selector)].find(isVisible);
      return element?.innerText?.trim().replace(/\s+/g, ' ') || '';
    }
  }, code);

  if (productInfo) return productInfo;

  const apiResponse = await searchApiResponsePromise;
  const catalogAudit = await auditExactCatalogSearch(page, apiResponse, code);
  debug.record({ event: 'search-catalog-audit', code, ...catalogAudit, product: undefined });
  if (catalogAudit.found) {
    return {
      code,
      name: catalogAudit.product?.descripcion || catalogAudit.product?.nombreProducto || '',
      brand: catalogAudit.product?.marca || '',
      price: '',
      canAdd: false,
      actionType: 'unavailable',
      unavailableReason: `Exact code exists in catalog API but its card was not rendered (API page ${catalogAudit.page})`,
    };
  }

  const unavailableReason = catalogAudit.complete
    ? `Exact code absent from active catalog (${catalogAudit.scanned}/${catalogAudit.totalHits} API results scanned)`
    : catalogAudit.error
      ? `Could not complete exact catalog search: ${catalogAudit.error}`
      : `Exact code absent from ${catalogAudit.scanned} accessible API results (backend reported ${catalogAudit.totalHits})`;
  return {
    code,
    name: '',
    brand: '',
    price: '',
    canAdd: false,
    actionType: 'unavailable',
    unavailableReason,
  };
}

function waitForProductSearchResponse(page, code, timeout) {
  return page
    .waitForResponse(
      response => {
        const request = response.request();
        if (request.method() !== 'POST' || !/\/producto-index-pedido\/buscar(?:\?|$)/i.test(response.url())) return false;
        const payload = parseJson(request.postData());
        return String(payload?.query || '') === String(code);
      },
      { timeout }
    )
    .catch(() => null);
}

async function auditExactCatalogSearch(page, firstResponse, code) {
  if (!firstResponse) {
    return { found: false, complete: false, scanned: 0, totalHits: null, error: 'search API response not observed' };
  }
  const firstPayload = await readResponseJson(firstResponse);
  const totalHits = Number(firstPayload?.totalHits);
  const request = firstResponse.request();
  const baseBody = parseJson(request.postData());
  const authorization = request.headers().authorization || '';
  if (!baseBody || !Number.isFinite(totalHits) || !authorization) {
    return { found: false, complete: false, scanned: 0, totalHits: Number.isFinite(totalHits) ? totalHits : null, error: 'search API metadata incomplete' };
  }

  const pageSize = 500;
  const maxPages = Math.max(1, Math.ceil(totalHits / pageSize));
  let scanned = 0;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const result = await page.evaluate(
      async ({ url, auth, body, currentPage, size }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              Accept: 'application/json',
              Authorization: auth,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...body, page: String(currentPage), pageSize: String(size) }),
            signal: controller.signal,
          });
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
          const payload = await response.json();
          return { ok: true, products: Array.isArray(payload?.productos) ? payload.productos : [] };
        } catch (error) {
          return { ok: false, error: error.message };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        url: firstResponse.url(),
        auth: authorization,
        body: baseBody,
        currentPage: pageNumber,
        size: pageSize,
      }
    );
    if (!result.ok) {
      return { found: false, complete: false, scanned, totalHits, error: result.error || 'catalog API request failed' };
    }
    const products = result.products || [];
    const product = products.find(item => String(item?.codigoCl) === String(code));
    scanned += products.length;
    if (product) return { found: true, complete: true, scanned, totalHits, page: pageNumber, product };
    if (products.length === 0) break;
  }

  return { found: false, complete: scanned >= totalHits, scanned, totalHits, error: '' };
}

async function addToCart(page, productInfo, quantity) {
  if (!productInfo.canAdd) {
    logger.warn(`Product ${productInfo.code} cannot be added: ${productInfo.unavailableReason}`);
    debug.record({ event: 'add-skip-cannotAdd', code: productInfo.code, reason: productInfo.unavailableReason });
    return { added: 0, reason: productInfo.unavailableReason || 'cannot add' };
  }

  logger.info(
    `Found product: Code - ${productInfo.code}, Name - ${productInfo.name || 'N/A'}, Price - ${productInfo.price || 'N/A'}`
  );

  if (productInfo.actionType === 'select-variant') {
    const prepared = await prepareVariantProduct(page, productInfo);
    if (!prepared.ok) {
      logger.warn(`Could not prepare variant ${productInfo.code}: ${prepared.reason}`);
      debug.record({ event: 'variant-prepare-failed', code: productInfo.code, result: prepared });
      return { added: 0, reason: prepared.reason };
    }
    debug.record({ event: 'variant-prepared', code: productInfo.code, result: prepared });
    await debug.savePageHtml(page, `${productInfo.code}/variant-pdp-ready`);
  }

  const cartCountBefore = await getCartItemCount(page);
  debug.record({
    event: 'add-start',
    code: productInfo.code,
    requestedQuantity: quantity,
    cartCountBefore,
    actionType: productInfo.actionType || 'add',
  });

  // Keyboard/input events are debounced by the current Novaventa React
  // component. Use the real +/- buttons and require the controlled value to
  // settle before clicking Agregar.
  const setQuantityResult = await setProductQuantity(page, productInfo, quantity);
  if (!setQuantityResult.ok) {
    logger.warn(`Could not set quantity for ${productInfo.code}: ${setQuantityResult.reason}`);
    return { added: 0, reason: setQuantityResult.reason || 'could not set quantity' };
  }
  debug.record({ event: 'set-quantity', code: productInfo.code, requestedQuantity: quantity, result: setQuantityResult });
  await debug.saveCardHtml(page, productInfo.code, 'card-after-set-quantity');

  // Install both listeners before clicking; the site PATCHes the requested
  // quantity and immediately refreshes the cart via GET.
  const mutationPromise = waitForCartMutation(page, productInfo.code, 20000);
  const cartRefreshPromise = waitForCartRefresh(page, productInfo.code, 3000);
  const clicked = await clickAddButton(page, productInfo);
  if (!clicked) {
    logger.warn(`Add button for ${productInfo.code} could not be clicked.`);
    debug.record({ event: 'add-click-failed', code: productInfo.code });
    await debug.saveCardHtml(page, productInfo.code, 'card-add-click-failed');
    return { added: 0, reason: 'add button could not be clicked' };
  }
  debug.record({ event: 'add-click', code: productInfo.code });

  const [mutationResponse, cartRefreshResult] = await Promise.all([
    mutationPromise,
    cartRefreshPromise,
  ]);
  const networkVerification = await verifyCartNetworkResult(
    mutationResponse,
    cartRefreshResult,
    productInfo.code,
    quantity
  );

  await debug.saveCardHtml(page, productInfo.code, 'card-after-click');

  const cartCountAfter = await getCartItemCount(page);
  const badgeDelta = Number.isFinite(cartCountBefore) && Number.isFinite(cartCountAfter)
    ? cartCountAfter - cartCountBefore
    : NaN;
  const diagnosis = await diagnoseAddOutcome(page, productInfo.code);

  // The refreshed cart line is authoritative. A successful PATCH is the next
  // best source. The badge is only a last-resort fallback for a one-unit SKU,
  // because it cannot identify which product changed.
  let added = networkVerification.actualQuantity;
  let source = networkVerification.source;
  if (!Number.isFinite(added) && quantity === 1 && badgeDelta > 0) {
    added = 1;
    source = 'badge-line-fallback';
  }
  if (!Number.isFinite(added)) added = 0;

  debug.record({
    event: 'add-result',
    code: productInfo.code,
    cartCountBefore,
    cartCountAfter,
    badgeDelta,
    requestedQuantity: quantity,
    addedFinal: added,
    source,
    networkVerification,
    diagnosis,
  });

  if (added >= quantity && quantity > 0) {
    logger.info(`Product ${productInfo.code} added to cart with quantity ${added} (source=${source}).`);
    return { added, reason: '' };
  }

  if (added > 0 && added < quantity) {
    const reason = networkVerification.reason || diagnosis.reasonLabel || 'partial add';
    logger.warn(
      `Product ${productInfo.code} only added ${added} of ${quantity} requested (${reason}).`
    );
    return { added, reason };
  }

  // added === 0: nothing was added.
  const failureReason = networkVerification.reason || diagnosis.reasonLabel;
  if (failureReason) {
    logger.warn(`Product ${productInfo.code} could not be added: ${failureReason}.`);
    return { added: 0, reason: failureReason };
  }

  logger.warn(`Product ${productInfo.code} did not increase cart quantity (no diagnostic info found).`);
  return { added: 0, reason: 'did not increase cart quantity' };
}

// Inspect the page after clicking Agregar to figure out why the add failed
// or only partially succeeded. Returns a structured object plus a short
// human-readable reasonLabel suitable for the summary output.
async function diagnoseAddOutcome(page, code) {
  return page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
      ),
    ];
    const exactCl = new RegExp(`^CL:\\s*${searchedCode}(?!\\d)`, 'i');
    const card = cards.find(element =>
      [...element.querySelectorAll('[class*="__cl"], label')].some(node =>
        exactCl.test((node.textContent || '').trim())
      )
    );
    const scope = card || document;

    const isVisible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const alertNodes = [
      ...scope.querySelectorAll(
        '[class*="alert--on"], [data-testid="product-warning"], [class*="agotado"], [class*="limite-unidades"], [class*="puntos-insuficientes"]'
      ),
    ].filter(isVisible);
    const alertText = alertNodes
      .map(element => (element.innerText || '').trim())
      .filter(Boolean)
      .join(' ');
    const hasAgotado = /AGOTADO|no está disponible en este momento|fuera de stock/i.test(alertText);
    const limitMatch = alertText.match(/No puedes agregar más de\s*(\d+)/i);
    const hasPuntosError = /Puntos insuficientes|alcanzaste el límite/i.test(alertText);

    let reasonLabel = '';
    if (hasAgotado) {
      reasonLabel = 'AGOTADO';
    } else if (limitMatch) {
      reasonLabel = `Límite por pedido: ${limitMatch[1]}`;
    } else if (hasPuntosError) {
      reasonLabel = `Puntos insuficientes: ${alertText.slice(0, 120)}`;
    }

    return {
      reasonLabel,
      hasAgotado,
      alertText: alertText.slice(0, 200),
      limitNumber: limitMatch ? Number(limitMatch[1]) : null,
      cardMissing: !card,
    };
  }, code);
}

async function prepareVariantProduct(page, productInfo) {
  let targetUrl;
  try {
    targetUrl = new URL(productInfo.pdpPath, officeUrl);
  } catch (error) {
    return { ok: false, reason: `invalid variant URL: ${error.message}` };
  }
  if (targetUrl.origin !== new URL(officeUrl).origin) {
    return { ok: false, reason: 'variant URL points outside Oficina Virtual' };
  }
  targetUrl.searchParams.set('cl', productInfo.code);

  await page.goto(targetUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
    debug.record({ event: 'variant-navigation-timeout', code: productInfo.code, error: error.message });
  });
  try {
    await page.waitForFunction(
      searchedCode => {
        const hasCode = new RegExp(`CL:\\s*${searchedCode}\\b`, 'i').test(document.body?.innerText || '');
        const addButton = [...document.querySelectorAll('button')].find(button => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !button.disabled && /^\s*Agregar\s*$/i.test(button.textContent || '');
        });
        return hasCode && !!addButton;
      },
      { timeout: 30000 },
      productInfo.code
    );
  } catch (error) {
    return { ok: false, reason: `variant PDP did not become addable: ${error.message}` };
  }

  return page.evaluate(searchedCode => {
    const selected = [...document.querySelectorAll('button[class*="option--selected"]')].find(button => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const exactCodeVisible = new RegExp(`CL:\\s*${searchedCode}\\b`, 'i').test(document.body?.innerText || '');
    const urlCode = new URL(location.href).searchParams.get('cl');
    if (!exactCodeVisible || urlCode !== searchedCode) {
      return { ok: false, reason: `variant identity mismatch (url=${urlCode || 'none'})` };
    }
    return {
      ok: true,
      url: location.href,
      selectedOption: selected?.querySelector('img[alt]')?.getAttribute('alt') || (selected?.innerText || '').trim(),
    };
  }, productInfo.code);
}

async function setProductQuantity(page, productInfo, desiredQuantity) {
  if (!Number.isInteger(desiredQuantity) || desiredQuantity < 1 || desiredQuantity > 999) {
    return { ok: false, reason: `invalid desired quantity: ${desiredQuantity}` };
  }

  let state = await getQuantityControlState(page, productInfo);
  if (!state.found) return { ok: false, reason: state.reason };

  for (let step = 0; state.value !== desiredQuantity && step < 100; step += 1) {
    const direction = state.value < desiredQuantity ? 'increase' : 'decrease';
    const previousValue = state.value;
    const clicked = await clickQuantityControl(page, productInfo, direction);
    if (!clicked) {
      return { ok: false, reason: `${direction} quantity control unavailable at ${previousValue}` };
    }
    try {
      await page.waitForFunction(
        (info, before) => {
          const input = findQuantityInput(info);
          return Number(input?.value) !== before;

          function findQuantityInput(product) {
            const isVisible = element => {
              if (!element) return false;
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            const exactCl = new RegExp(`^CL:\\s*${product.code}(?!\\d)`, 'i');
            const card = [...document.querySelectorAll('[class*="product-item-card"]')].find(element =>
              [...element.querySelectorAll('[class*="__cl"], label')].some(node => exactCl.test((node.textContent || '').trim()))
            );
            const root = product.actionType === 'select-variant' ? document : card;
            return [...(root?.querySelectorAll('[data-testid="numeric-up-down-input"], input[type="number"]') || [])].find(isVisible);
          }
        },
        { timeout: 3000 },
        productInfo,
        previousValue
      );
    } catch (error) {
      return { ok: false, reason: `quantity did not react after ${direction} click` };
    }
    state = await getQuantityControlState(page, productInfo);
    if (!state.found) return { ok: false, reason: state.reason };
  }

  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(150);
  state = await getQuantityControlState(page, productInfo);
  if (!state.found || state.value !== desiredQuantity) {
    return { ok: false, reason: `quantity did not settle at ${desiredQuantity} (actual=${state.value ?? 'unknown'})` };
  }
  return { ok: true, value: state.value, method: 'numeric-buttons' };
}

async function getQuantityControlState(page, productInfo) {
  return page.evaluate(info => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const exactCl = new RegExp(`^CL:\\s*${info.code}(?!\\d)`, 'i');
    const card = [...document.querySelectorAll('[class*="product-item-card"]')].find(element =>
      [...element.querySelectorAll('[class*="__cl"], label')].some(node => exactCl.test((node.textContent || '').trim()))
    );
    const root = info.actionType === 'select-variant' ? document : card;
    if (!root) return { found: false, reason: info.actionType === 'select-variant' ? 'variant PDP not found' : 'card-not-found' };
    const input = [...root.querySelectorAll('[data-testid="numeric-up-down-input"], input[type="number"]')].find(isVisible);
    if (!input) return { found: false, reason: 'quantity-input-not-found' };
    const value = Number(input.value);
    return Number.isFinite(value) ? { found: true, value } : { found: false, reason: `invalid quantity value: ${input.value}` };
  }, productInfo);
}

async function clickQuantityControl(page, productInfo, direction) {
  return page.evaluate((info, wantedDirection) => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const exactCl = new RegExp(`^CL:\\s*${info.code}(?!\\d)`, 'i');
    const card = [...document.querySelectorAll('[class*="product-item-card"]')].find(element =>
      [...element.querySelectorAll('[class*="__cl"], label')].some(node => exactCl.test((node.textContent || '').trim()))
    );
    const root = info.actionType === 'select-variant' ? document : card;
    if (!root) return false;
    const input = [...root.querySelectorAll('[data-testid="numeric-up-down-input"], input[type="number"]')].find(isVisible);
    const controls = input?.parentElement?.closest('[class*="numeric-up-down"]') || input?.parentElement || root;
    const selector = wantedDirection === 'increase'
      ? 'button[data-testid="numeric-up-down__down"]'
      : 'button[data-testid="numeric-up-down__up"]';
    const expectedIcon = wantedDirection === 'increase' ? /plus|incrementar|aumentar/i : /minus|disminuir|reducir/i;
    const button =
      [...controls.querySelectorAll(selector)].find(isVisible) ||
      [...controls.querySelectorAll('button')].find(candidate => {
        const iconText = [
          candidate.getAttribute('aria-label') || '',
          candidate.getAttribute('title') || '',
          candidate.querySelector('[title]')?.getAttribute('title') || '',
        ].join(' ');
        return isVisible(candidate) && expectedIcon.test(iconText);
      });
    if (!button || button.disabled) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  }, productInfo, direction);
}

async function clickAddButton(page, productInfo) {
  return page.evaluate(info => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const exactCl = new RegExp(`^CL:\\s*${info.code}(?!\\d)`, 'i');
    const card = [...document.querySelectorAll('[class*="product-item-card"]')].find(element =>
      [...element.querySelectorAll('[class*="__cl"], label')].some(node => exactCl.test((node.textContent || '').trim()))
    );
    const root = info.actionType === 'select-variant' ? document : card;
    const addButton = [...(root?.querySelectorAll('button') || [])].find(button =>
      isVisible(button) && /^\s*Agregar\s*$/i.test(button.textContent || '')
    );
    if (!addButton || addButton.disabled) return false;
    addButton.scrollIntoView({ block: 'center' });
    addButton.click();
    return true;
  }, productInfo);
}

function waitForCartMutation(page, code, timeout) {
  return page
    .waitForResponse(
      response => {
        const request = response.request();
        if (request.method() !== 'PATCH' || !/\/carrito\/modificarDetalle(?:\?|$)/i.test(response.url())) return false;
        try {
          const payload = JSON.parse(request.postData() || '{}');
          return String(payload.codigoCl) === String(code);
        } catch (error) {
          return true;
        }
      },
      { timeout }
    )
    .catch(() => null);
}

function waitForCartRefresh(page, code, timeout) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      page.off('response', onResponse);
      resolve(result);
    };
    const onResponse = async response => {
      if (
        response.request().method() !== 'GET' ||
        !/\/carrito\/getCarritoByUuid(?:\/|\?|$)/i.test(response.url()) ||
        response.status() < 200 ||
        response.status() >= 300
      ) return;
      const payload = await readResponseJson(response);
      const products = findDeepValue(payload, 'productos');
      if (Array.isArray(products) && products.some(product => String(product?.codigoCl) === String(code))) {
        finish({ response, payload });
      }
    };
    const timeoutId = setTimeout(() => finish(null), timeout);
    page.on('response', onResponse);
  });
}

async function verifyCartNetworkResult(mutationResponse, cartRefreshResult, code, requestedQuantity) {
  const mutationRequest = parseJson(mutationResponse?.request().postData());
  const mutationPayload = await readResponseJson(mutationResponse);
  const cartRefreshResponse = cartRefreshResult?.response || null;
  const cartPayload = cartRefreshResponse && cartRefreshResponse.status() >= 200 && cartRefreshResponse.status() < 300
    ? cartRefreshResult.payload
    : null;
  const requestQuantity = Number(mutationRequest?.cantidad);
  const requestCode = mutationRequest?.codigoCl == null ? '' : String(mutationRequest.codigoCl);
  const mutationState = String(findDeepValue(mutationPayload, 'estadoModificacion') || '');
  const mutationHttpOk = Boolean(
    mutationResponse && mutationResponse.status() >= 200 && mutationResponse.status() < 300
  );
  const products = findDeepValue(cartPayload, 'productos');
  const cartLine = Array.isArray(products)
    ? products.find(product => String(product?.codigoCl) === String(code))
    : null;
  const cartQuantity = Array.isArray(products)
    ? (cartLine ? Number(cartLine.cantidad) : 0)
    : NaN;

  let actualQuantity = Number.isFinite(cartQuantity) ? cartQuantity : NaN;
  let source = Number.isFinite(cartQuantity) ? 'cart-refresh' : 'unverified';
  if (!Number.isFinite(actualQuantity) && mutationHttpOk && /^OK$/i.test(mutationState) && requestCode === String(code) && Number.isFinite(requestQuantity)) {
    actualQuantity = requestQuantity;
    source = 'cart-mutation';
  }

  let reason = '';
  if (Number.isFinite(requestQuantity) && requestQuantity !== requestedQuantity) {
    reason = `quantity request mismatch: sent ${requestQuantity}, requested ${requestedQuantity}`;
  } else if (mutationResponse && !mutationHttpOk) {
    reason = `cart mutation HTTP ${mutationResponse.status()}`;
  } else if (mutationState && !/^OK$/i.test(mutationState)) {
    const limit = Number(findDeepValue(mutationPayload, 'limiteUnidades'));
    reason = /^AGOTADO$/i.test(mutationState)
      ? 'AGOTADO'
      : /LIMITE_UNIDADES_SUPERADO/i.test(mutationState)
        ? `Límite por pedido${Number.isFinite(limit) ? `: ${limit}` : ''}`
        : mutationState;
  } else if (Number.isFinite(actualQuantity) && actualQuantity !== requestedQuantity) {
    reason = `cart persisted ${actualQuantity} of ${requestedQuantity}`;
  } else if (!mutationResponse && !cartRefreshResponse) {
    reason = 'cart API confirmation not observed';
  }

  return {
    actualQuantity,
    source,
    reason,
    mutationHttpStatus: mutationResponse?.status() || null,
    mutationState,
    requestCode,
    requestQuantity: Number.isFinite(requestQuantity) ? requestQuantity : null,
    cartQuantity: Number.isFinite(cartQuantity) ? cartQuantity : null,
  };
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

async function readResponseJson(response) {
  if (!response) return null;
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function findDeepValue(value, key, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const nested of Object.values(value)) {
    const found = findDeepValue(nested, key, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function getCartState(page) {
  await dismissSessionTimeoutModal(page);
  const opened = await openCartIfNeeded(page);
  await sleep(1200);
  let state = null;
  let previousSignature = '';
  let stableReads = 0;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    state = await page.evaluate(openSucceeded => {
    const isVisible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const drawerSelectors = [
      '[class*="carrito-popover"]',
      '[class*="carrito-container"]',
      'aside[class*="carrito"]',
    ];
    let drawer = null;
    for (const selector of drawerSelectors) {
      drawer = [...document.querySelectorAll(selector)].find(isVisible);
      if (drawer) break;
    }
    const scope = drawer || document;
    const rows = [...scope.querySelectorAll('article[class*="producto-carrito-layout_producto"]')].filter(isVisible);
    const items = rows
      .map(row => {
        const clText = [...row.querySelectorAll('[class*="__cl"], label')]
          .map(node => (node.textContent || '').trim())
          .find(text => /^CL:\s*\d+$/i.test(text)) || '';
        const code = clText.match(/^CL:\s*(\d+)$/i)?.[1] || '';
        const input = [...row.querySelectorAll('[data-testid="numeric-up-down-input"], input[type="number"]')].find(isVisible);
        const quantity = Number(input?.value);
        const name = row.querySelector('[class*="descripcion"]')?.textContent?.trim().replace(/\s+/g, ' ') || '';
        const price = row.querySelector('[class*="producto-carrito-precio"]')?.textContent?.trim().replace(/\s+/g, ' ') || '';
        return { code, quantity, name, price };
      })
      .filter(item => item.code && Number.isFinite(item.quantity));

    const emptyMarker = [...scope.querySelectorAll('[class*="empty"], [class*="vacio"], [class*="vacío"]')]
      .find(element => isVisible(element) && /Aún no tienes artículos|Carrito vacío|sin artículos/i.test(element.innerText || ''));
    const scopeText = drawer?.innerText || '';
    const explicitlyEmpty = !!emptyMarker || /Aún no tienes artículos|Carrito vacío/i.test(scopeText);
    const badgeCounter = document.querySelector(
      '[data-testid="carrito-badge"] [class*="image-counter"], [data-testid="carrito-badge"] #carrito-badge-counter > span:not(.sr-only)'
    );
    const badgeMatch = (badgeCounter?.textContent || '').trim().match(/^\d+$/);
    const unitsNode = [...scope.querySelectorAll('[data-testid="cantidadItem"] h3, [data-testid="cantidadItem"]')].find(isVisible);
    const unitsMatch = (unitsNode?.textContent || '').match(/\d+/);
    const totalNode = [...scope.querySelectorAll('[data-testid="subtotalPrecioCatalogo"], [class*="total-pedido"], [class*="pedido-total"]')]
      .find(element => isVisible(element) && /\$/.test(element.textContent || ''));

    return {
      authoritative: !!drawer && (items.length > 0 || explicitlyEmpty),
      panelOpen: !!drawer || openSucceeded,
      explicitlyEmpty,
      badgeCount: badgeMatch ? Number(badgeMatch[0]) : null,
      lineCount: items.length,
      unitCount: items.reduce((sum, item) => sum + item.quantity, 0),
      displayedUnitCount: unitsMatch ? Number(unitsMatch[0]) : null,
      total: totalNode?.textContent?.trim().replace(/\s+/g, ' ') || '',
      items,
    };
    }, opened);

    const rowsComplete = state.explicitlyEmpty || state.items.length > 0;
    const unitsComplete =
      (state.displayedUnitCount == null || state.displayedUnitCount === state.unitCount) &&
      (state.badgeCount == null || state.badgeCount === state.unitCount);
    const signature = JSON.stringify(state.items.map(item => [item.code, item.quantity]));
    stableReads = rowsComplete && unitsComplete && signature === previousSignature ? stableReads + 1 : 1;
    previousSignature = signature;
    if (state.authoritative && rowsComplete && unitsComplete && stableReads >= 2) break;
    await sleep(350);
  }
  const rowsComplete = state.explicitlyEmpty || state.items.length > 0;
  const unitsComplete =
    (state.displayedUnitCount == null || state.displayedUnitCount === state.unitCount) &&
    (state.badgeCount == null || state.badgeCount === state.unitCount);
  state.authoritative = Boolean(state.authoritative && rowsComplete && unitsComplete && stableReads >= 2);
  state.stableReads = stableReads;
  debug.record({ event: 'cart-reconciliation', state });
  await debug.saveCartHtml(page, 'final-reconciliation');
  return state;
}

function reconcileRunResults(products, executionSuccessful, executionErrors, cartState) {
  if (!cartState?.authoritative) {
    const fallbackErrors = [...executionErrors, {
      code: 'CART_VERIFICATION',
      error: 'Final cart drawer could not be verified authoritatively',
    }];
    return { successfulProducts: executionSuccessful, errorProducts: fallbackErrors };
  }

  const requested = new Map();
  for (const product of products) {
    requested.set(product.code, (requested.get(product.code) || 0) + product.quantity);
  }
  const cartByCode = new Map(cartState.items.map(item => [item.code, item]));
  const successfulByCode = new Map(executionSuccessful.map(item => [item.code, item]));
  const errorByCode = new Map(executionErrors.map(item => [item.code, item]));
  const successfulProducts = [];
  const errorProducts = [];

  for (const [code, requestedQuantity] of requested) {
    const cartItem = cartByCode.get(code);
    const actualQuantity = cartItem?.quantity || 0;
    if (actualQuantity > 0) {
      successfulProducts.push({
        code,
        quantity: actualQuantity,
        name: cartItem?.name || successfulByCode.get(code)?.name || '',
      });
    }
    if (actualQuantity !== requestedQuantity) {
      const priorError = errorByCode.get(code)?.error;
      const mismatch = actualQuantity === 0
        ? 'Not present in final cart'
        : actualQuantity < requestedQuantity
          ? `Only ${actualQuantity} of ${requestedQuantity} present in final cart`
          : `Final cart has ${actualQuantity}; requested ${requestedQuantity}`;
      errorProducts.push({ code, error: priorError ? `${mismatch} — ${priorError}` : mismatch });
    }
  }

  for (const item of cartState.items) {
    if (!requested.has(item.code)) {
      errorProducts.push({ code: item.code, error: `Unexpected item in final cart (quantity ${item.quantity})` });
    }
  }
  return { successfulProducts, errorProducts };
}

function formatCartSummary(cartState) {
  if (!cartState?.authoritative) return 'Cart summary could not be verified';
  return [
    `lines=${cartState.lineCount}`,
    `units=${cartState.unitCount}`,
    cartState.total && `total=${cartState.total}`,
  ].filter(Boolean).join(' | ');
}

async function getCartItemCount(page) {
  return page.evaluate(() => {
    const candidates = [
      '[data-testid="carrito-badge"] [class*="image-counter"]',
      '[data-testid="carrito-badge"] #carrito-badge-counter > span:not(.sr-only)',
    ];
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const raw = (element.innerText || element.textContent || '').trim();
      if (!raw) continue;
      if (/^\d+$/.test(raw)) return Number(raw);
    }
    return null;
  });
}

async function getVisibleText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function takeScreenshot(page, filename) {
  const screenshotPath = path.join(screenshotsDir, filename);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  logger.info(`Screenshot saved: ${screenshotPath}`);
}

async function outputSummary(successfulProducts, errorProducts) {
  logger.info('\nSummary:\n');

  if (successfulProducts.length > 0) {
    logger.info(`${successfulProducts.length} products successfully added to the cart:`);
    successfulProducts.forEach(product => {
      logger.info(`- Code: ${product.code}, Quantity: ${product.quantity}, Name: ${product.name || 'N/A'}`);
    });
  } else {
    logger.info('No products were successfully added to the cart.');
  }

  if (errorProducts.length > 0) {
    logger.info('\nProducts that encountered errors:');
    errorProducts.forEach(product => {
      logger.info(`- Code: ${product.code}, Error: ${product.error}`);
    });
  } else {
    logger.info('\nNo errors encountered during processing.');
  }
}
