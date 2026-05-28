const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

dotenv.config();

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
const browserProfileDir = path.join(__dirname, '.browser-profile-office');
const headless = String(process.env.HEADLESS || '').toLowerCase() === 'true';
const manualLogin = String(process.env.NOVAVENTA_MANUAL_LOGIN || 'true').toLowerCase() !== 'false';
const debugMode = String(process.env.DEBUG_LOGS ?? 'true').toLowerCase() !== 'false';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        const card = cards.find(element => element.innerText?.includes(`CL: ${code}`));
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
    await loginOfficeVirtual(page);
    await chooseOfficeVirtualModeIfPrompted(page);
    await debug.savePageHtml(page, 'after-login');
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

    await outputSummary(successfulProducts, errorProducts);
    const finalSummary = await getCartSummary(page);
    logger.info(`Cart total: ${finalSummary}`);
    debug.record({ event: 'run-end', successCount: successfulProducts.length, errorCount: errorProducts.length, cartSummary: finalSummary, errorProducts });
    await debug.savePageHtml(page, 'final');
  } catch (error) {
    logger.error(`An unexpected error occurred: ${error.message}`);
    await takeScreenshot(page, 'unexpected_error.png');
    await debug.savePageHtml(page, 'unexpected-error');
    debug.record({ event: 'unexpected-error', message: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

async function loginOfficeVirtual(page) {
  const username = process.env.NOVAVENTA_USERNAME;
  const password = process.env.NOVAVENTA_PASSWORD;

  logger.info('Opening Oficina Virtual.');
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

  if (manualLogin) {
    await waitForManualOfficeLogin(page);
    return;
  }

  if (!username || !password) {
    throw new Error('Missing NOVAVENTA_USERNAME or NOVAVENTA_PASSWORD in .env, or set NOVAVENTA_MANUAL_LOGIN=true');
  }

  await page.waitForSelector('form input[type="password"]', {
    visible: true,
    timeout: 60000,
  });

  // The cédula input is the first text input inside the login form, with placeholder "Ej. 1234567890".
  await typeIntoFirstMatchingInput(
    page,
    'form input[placeholder*="1234567890"], form input[type="text"]:not([type="password"])',
    username
  );
  await typeIntoFirstMatchingInput(page, 'form input[type="password"]', password);

  logger.info('Submitting Oficina Virtual credentials.');
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }),
    clickLoginSubmit(page),
  ]);

  await sleep(8000);

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
  throw new Error(loginError || 'Could not log in to Oficina Virtual.');
}

async function waitForManualOfficeLogin(page) {
  logger.info('Manual login mode enabled.');
  logger.info('Inicia sesión con cédula + contraseña directamente en la ventana del navegador.');
  logger.info('Si solo ves el botón "Inicia sesión desde Tienda Virtual", recarga o usa ese flujo.');

  await gotoOfficeHome(page);

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
        const hasPasswordInput = !!document.querySelector('form input[type="password"]');
        const text = document.body?.innerText || '';
        const looksLoggedIn = /Hola|Cerrar sesión|Total pedido|Cupo disponible|Mi pedido|HACER MI PEDIDO|Novaempresario|carrito|Buscar por código/i.test(text);
        const showsTiendaFallback = /Inicia sesión desde Tienda Virtual/i.test(text);
        return hasPasswordInput || looksLoggedIn || showsTiendaFallback;
      },
      { timeout: 45000 }
    );
  } catch (error) {
    logger.warn(`Did not find login form or session indicator: ${error.message}`);
  }
}

async function clickLoginSubmit(page) {
  const clicked = await page.evaluate(() => {
    const form = document.querySelector('form');
    const submit =
      form?.querySelector('button[type="submit"]') ||
      [...(form?.querySelectorAll('button') || [])].find(button => /Inicia sesión/i.test(button.textContent || ''));

    if (!submit) return false;
    submit.scrollIntoView({ block: 'center' });
    submit.click();
    return true;
  });

  if (!clicked) {
    // Fall back to the generic button-by-text helper.
    await clickButtonByText(page, /Inicia sesión/i);
  }
}

async function isLoggedInOfficeVirtual(page) {
  const url = page.url();
  if (!url.startsWith(officeUrl)) return false;

  const hasLoginForm = await page
    .evaluate(() => !!document.querySelector('form input[type="password"]'))
    .catch(() => false);
  if (hasLoginForm) return false;

  const text = await getVisibleText(page);

  if (/Usuario o contraseña son incorrectos/i.test(text)) return false;
  if (/Inicia sesión con cédula y contraseña/i.test(text)) return false;
  // The unauthenticated landing only shows the "Inicia sesión desde Tienda Virtual" CTA
  // and the word "ESTÁS EN"; if those are visible without any logged-in hints, treat as not logged in.
  if (/Inicia sesión desde Tienda Virtual/i.test(text) && !/Hola|Cerrar sesión|Mi pedido|Total pedido|Cupo disponible|Novaempresario|HACER MI PEDIDO|MI NEGOCIO|MI PEDIDO|carrito/i.test(text)) {
    return false;
  }

  return /Hola|HACER MI PEDIDO|Realizar pedido|Mi negocio|Mi pedido|MI PEDIDO|MI NEGOCIO|Historial de pedidos|Cerrar sesión|Total pedido|Cupo disponible|Novaempresario|Carrito|Buscar por código/i.test(text);
}

async function typeIntoFirstMatchingInput(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.evaluate(
    (inputSelector, inputValue) => {
      const input = document.querySelector(inputSelector);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, inputValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    value
  );
}

async function clickButtonByText(page, textRegex) {
  const clicked = await page.evaluate(regexSource => {
    const regex = new RegExp(regexSource, 'i');
    const buttons = [...document.querySelectorAll('button, a')];
    const button = buttons.find(element => regex.test(element.textContent || ''));

    if (!button) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  }, textRegex.source);

  if (!clicked) throw new Error(`Button not found: ${textRegex}`);
}

function extractLoginError(bodyText) {
  if (/Usuario o contraseña son incorrectos/i.test(bodyText)) {
    return 'Oficina Virtual rejected the configured credentials: Usuario o contraseña son incorrectos.';
  }

  if (/Completa el reCAPTCHA/i.test(bodyText)) {
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
  await openCartIfNeeded(page);
  await sleep(1500);

  let currentCount = await getCartItemCount(page);
  const visibleDeleteCount = await countVisibleDeleteButtons(page);
  debug.record({ event: 'clear-cart-initial', currentCount, visibleDeleteCount });

  if (currentCount === 0 && visibleDeleteCount === 0) {
    logger.info('Cart already empty.');
    return;
  }
  logger.info(`Cart has ${currentCount || visibleDeleteCount} items, clearing...`);

  // The cart panel can be dismissed mid-loop (user clicks outside, modal autocloses
  // after a delete, etc.). The badge counter is always visible in the header, so we
  // trust it as the source of truth and re-open the panel whenever the delete
  // buttons disappear while items remain.
  let consecutiveReopens = 0;
  const maxReopens = 8;

  for (let attempt = 1; attempt <= 200; attempt += 1) {
    // The idle-session modal can pop while we are still deleting. Always dismiss
    // it first so it can't intercept our delete clicks.
    await dismissSessionTimeoutModal(page);

    currentCount = await getCartItemCount(page);
    const remainingDeleteButtons = await countVisibleDeleteButtons(page);
    debug.record({ event: 'clear-cart-iteration', attempt, currentCount, remainingDeleteButtons });

    if (currentCount === 0 && remainingDeleteButtons === 0) {
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

    const clicked = await page.evaluate(() => {
      const selectors = [
        '[data-testid*="eliminar"]',
        '[data-testid*="trash"]',
        '[data-testid*="delete"]',
        'button[class*="eliminar"]',
        'button[class*="trash"]',
        'button[aria-label*="eliminar" i]',
        'button[aria-label*="quitar" i]',
      ];

      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button && isVisible(button)) {
          button.scrollIntoView({ block: 'center' });
          button.click();
          return true;
        }
      }

      const trashButton = [...document.querySelectorAll('button')].find(button => {
        if (!isVisible(button)) return false;
        const haystack = (button.textContent || '') + ' ' + (button.getAttribute('aria-label') || '');
        return /eliminar|borrar|quitar|remove|trash/i.test(haystack);
      });
      if (!trashButton) return false;

      trashButton.scrollIntoView({ block: 'center' });
      trashButton.click();
      return true;

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
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

    await page
      .waitForResponse(
        response =>
          /carrito|pedido|cart/i.test(response.url()) &&
          response.status() >= 200 &&
          response.status() < 300,
        { timeout: 15000 }
      )
      .catch(() => null);

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

    const seen = new Set();
    const selectors = [
      '[data-testid*="eliminar"]',
      '[data-testid*="trash"]',
      '[data-testid*="delete"]',
      'button[class*="eliminar"]',
      'button[class*="trash"]',
      'button[aria-label*="eliminar" i]',
      'button[aria-label*="quitar" i]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)) seen.add(element);
      }
    }
    return seen.size;
  });
}

async function isCartPanelOpen(page) {
  return page.evaluate(() => {
    // The cart drawer/modal contains delete buttons or item rows when open.
    // We accept "open" if any delete-button-like control is visible OR if a known
    // cart drawer container is present in the DOM with non-zero size.
    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const deleteIndicators = [
      '[data-testid*="eliminar"]',
      '[data-testid*="trash"]',
      '[data-testid*="delete"]',
      'button[class*="eliminar"]',
      'button[class*="trash"]',
      'button[aria-label*="eliminar" i]',
    ];
    for (const selector of deleteIndicators) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)) return true;
      }
    }

    const drawerCandidates = [
      'aside[class*="carrito"]',
      '[class*="cart-drawer"]',
      '[class*="cart-panel"]',
      '[class*="mini-cart"]',
      '[class*="modal_modal"][class*="active"]',
      '[role="dialog"]',
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
}

async function searchProduct(page, code) {
  logger.info(`Searching for product code: ${code}`);
  debug.record({ event: 'search-start', code });

  await ensureOfficeHome(page);

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
        if (text.includes(`CL: ${searchedCode}`)) return true;

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
    if (text.includes(`CL: ${searchedCode}`)) return false;
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

  return await page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));

    if (!card) return null;

    const buttons = [...card.querySelectorAll('button')];
    const addButton = buttons.find(button => /^\s*Agregar\s*$/i.test(button.textContent || ''));

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

    if (!addButton || addButton.disabled) {
      const warning = getText(card, '[data-testid="product-warning"], [class*="warning"], [class*="aviso"], [class*="agotado"]');
      const firstButton = buttons[0];
      return {
        ...baseInfo,
        canAdd: false,
        unavailableReason: warning || firstButton?.textContent.trim() || 'Add button not found',
      };
    }

    return { ...baseInfo, canAdd: true };

    function getText(root, selector) {
      return root.querySelector(selector)?.textContent.trim().replace(/\s+/g, ' ') || '';
    }
  }, code);
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

  const cartCountBefore = await getCartItemCount(page);
  const cantidadAddedBefore = await readCantidadAdded(page, productInfo.code);
  debug.record({
    event: 'add-start',
    code: productInfo.code,
    requestedQuantity: quantity,
    cartCountBefore,
    cantidadAddedBefore,
  });

  // The new UI lets us set the quantity once and click "Agregar" a single time.
  const setQuantityResult = await setProductQuantity(page, productInfo.code, quantity);
  if (!setQuantityResult.ok) {
    logger.warn(`Could not set quantity for ${productInfo.code}: ${setQuantityResult.reason}`);
  }
  debug.record({ event: 'set-quantity', code: productInfo.code, requestedQuantity: quantity, result: setQuantityResult });
  await debug.saveCardHtml(page, productInfo.code, 'card-after-set-quantity');

  const clicked = await clickAddButton(page, productInfo.code);
  if (!clicked) {
    logger.warn(`Add button for ${productInfo.code} could not be clicked.`);
    debug.record({ event: 'add-click-failed', code: productInfo.code });
    await debug.saveCardHtml(page, productInfo.code, 'card-add-click-failed');
    return { added: 0, reason: 'add button could not be clicked' };
  }
  debug.record({ event: 'add-click', code: productInfo.code });

  // Wait for the per-product counter inside the card to reflect the new value.
  // The global badge in the header is unreliable (it caps / lags), so we rely on
  // the card's own "cantidad-added__cantidad" span, which the site updates as soon
  // as the add API call returns. We give up after a few seconds and fall back to
  // best-effort diagnosis below.
  const targetCantidad = (cantidadAddedBefore || 0) + quantity;
  const cantidadAddedAfter = await waitForCantidadAdded(page, productInfo.code, targetCantidad, 8000);

  await debug.saveCardHtml(page, productInfo.code, 'card-after-click');

  const cartCountAfter = await getCartItemCount(page);
  const badgeDelta = cartCountAfter - cartCountBefore;
  const cardDelta = Number.isFinite(cantidadAddedAfter)
    ? cantidadAddedAfter - (cantidadAddedBefore || 0)
    : NaN;

  const diagnosis = await diagnoseAddOutcome(page, productInfo.code);

  // Decide how many units we actually added. Trust the per-product card delta
  // first (it reflects ONLY this add operation), then fall back to badge delta.
  let added = 0;
  let source = 'unknown';
  if (Number.isFinite(cardDelta) && cardDelta > 0) {
    added = Math.min(cardDelta, quantity);
    source = 'card-counter';
  } else if (badgeDelta > 0) {
    added = Math.min(badgeDelta, quantity);
    source = 'badge-delta';
  }

  debug.record({
    event: 'add-result',
    code: productInfo.code,
    cartCountBefore,
    cartCountAfter,
    badgeDelta,
    cantidadAddedBefore,
    cantidadAddedAfter,
    cardDelta,
    requestedQuantity: quantity,
    addedFinal: added,
    source,
    diagnosis,
  });

  if (added >= quantity && quantity > 0) {
    logger.info(`Product ${productInfo.code} added to cart with quantity ${added} (source=${source}).`);
    return { added, reason: '' };
  }

  if (added > 0 && added < quantity) {
    const reason = diagnosis.reasonLabel || 'partial add';
    logger.warn(
      `Product ${productInfo.code} only added ${added} of ${quantity} requested (${reason}).`
    );
    return { added, reason };
  }

  // added === 0: nothing was added.
  if (diagnosis.reasonLabel) {
    logger.warn(`Product ${productInfo.code} could not be added: ${diagnosis.reasonLabel}.`);
    return { added: 0, reason: diagnosis.reasonLabel };
  }

  logger.warn(`Product ${productInfo.code} did not increase cart quantity (no diagnostic info found).`);
  return { added: 0, reason: 'did not increase cart quantity' };
}

async function readCantidadAdded(page, code) {
  return page
    .evaluate(searchedCode => {
      const cards = [
        ...document.querySelectorAll(
          '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
        ),
      ];
      const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
      const node = card?.querySelector('[class*="cantidad-added__cantidad"]');
      const value = Number((node?.textContent || '').trim());
      return Number.isFinite(value) ? value : 0;
    }, code)
    .catch(() => 0);
}

// Wait for the per-product card to display the "added quantity" badge with at
// least the target value. Returns the parsed number, or NaN on timeout.
async function waitForCantidadAdded(page, code, targetValue, timeoutMs) {
  try {
    await page.waitForFunction(
      (searchedCode, want) => {
        const cards = [
          ...document.querySelectorAll(
            '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
          ),
        ];
        const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
        if (!card) return false;
        const node = card.querySelector('[class*="cantidad-added__cantidad"]');
        if (!node) return false;
        const value = Number((node.textContent || '').trim());
        if (!Number.isFinite(value) || value <= 0) return false;
        return value >= want;
      },
      { timeout: timeoutMs },
      code,
      targetValue
    );
  } catch (error) {
    // Timeout — fall through to read whatever value is in the card right now.
  }
  return readCantidadAdded(page, code);
}

// Inspect the page after clicking Agregar to figure out why the add failed
// or only partially succeeded. Returns a structured object plus a short
// human-readable reasonLabel suitable for the summary output.
async function diagnoseAddOutcome(page, code) {
  return page.evaluate(searchedCode => {
    const text = document.body?.innerText || '';

    // Locate the card for this product (limite-unidades alerts live inside it).
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
    const scope = card || document;

    const hasAgotado =
      /AGOTADO|no está disponible en este momento|fuera de stock/i.test(text) ||
      !!scope.querySelector('[class*="agotado"]');

    // limite-unidades has three subelements (icon, title, details). Pick the ones
    // that hold real text (title/details), not the icon.
    const limitTextNodes = [
      ...scope.querySelectorAll(
        '[class*="limite-unidades__title"], [class*="limite-unidades__details"]'
      ),
    ];
    const limitText = limitTextNodes
      .map(el => (el.innerText || '').trim())
      .filter(Boolean)
      .join(' ');
    const limitContainer = scope.querySelector('[class*="limite-unidades"]');
    const limitContainerText = (limitContainer?.innerText || '').trim();
    const limitMatch =
      limitText.match(/No puedes agregar más de\s*(\d+)/i) ||
      limitContainerText.match(/No puedes agregar más de\s*(\d+)/i) ||
      text.match(/No puedes agregar más de\s*(\d+)/i);

    const puntosNode = scope.querySelector('[class*="puntos-insuficientes"]');
    const puntosText = (puntosNode?.innerText || '').trim();
    const hasPuntosError = /Puntos insuficientes|alcanzaste el límite/i.test(text);

    const cantidadAddedEl = card?.querySelector('[class*="cantidad-added__cantidad"]');
    const cantidadAdded = (cantidadAddedEl?.textContent || '').trim();

    let reasonLabel = '';
    if (hasAgotado) {
      reasonLabel = 'AGOTADO';
    } else if (limitMatch) {
      reasonLabel = `Límite por pedido: ${limitMatch[1]}`;
    } else if (hasPuntosError || puntosText) {
      reasonLabel = `Puntos insuficientes${puntosText ? `: ${puntosText.slice(0, 120)}` : ''}`;
    }

    return {
      reasonLabel,
      hasAgotado,
      limitText: limitText.slice(0, 200) || limitContainerText.slice(0, 200),
      limitNumber: limitMatch ? Number(limitMatch[1]) : null,
      puntosText: puntosText.slice(0, 200),
      cantidadAdded,
      cardMissing: !card,
    };
  }, code);
}

async function setProductQuantity(page, code, desiredQuantity) {
  return page.evaluate(
    (searchedCode, qty) => {
      const cards = [
        ...document.querySelectorAll(
          '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
        ),
      ];
      const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
      if (!card) return { ok: false, reason: 'card-not-found' };

      const input =
        card.querySelector('[data-testid="numeric-up-down-input"]') ||
        card.querySelector('input[type="number"]');
      if (!input) return { ok: false, reason: 'quantity-input-not-found' };

      const targetValue = String(Math.max(1, qty));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, targetValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return { ok: true, value: input.value };
    },
    code,
    desiredQuantity
  );
}

async function clickAddButton(page, code) {
  return page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
    const addButton = [...(card?.querySelectorAll('button') || [])].find(button =>
      /^\s*Agregar\s*$/i.test(button.textContent || '')
    );

    if (!addButton || addButton.disabled) return false;

    addButton.scrollIntoView({ block: 'center' });
    addButton.click();
    return true;
  }, code);
}

async function getProductWarning(page, code) {
  return page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="product-list__container"] [class*="product-item-card"], [class*="product-item-card"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
    return (
      card
        ?.querySelector('[data-testid="product-warning"], [class*="warning"], [class*="aviso"], [class*="agotado"]')
        ?.textContent.trim().replace(/\s+/g, ' ') || ''
    );
  }, code);
}

async function getCartSummary(page) {
  return page.evaluate(() => {
    const badge = document.querySelector('[data-testid="carrito-badge"]');
    const counter = badge?.querySelector('[class*="cantidad-added"], #carrito-badge-counter, [class*="carrito-badge"]');
    const counterText = counter?.textContent?.trim().replace(/\s+/g, ' ') || '';

    const totalSelectors = [
      '[class*="total-pedido"]',
      '[class*="totalPedido"]',
      '[class*="pedido-total"]',
      '[class*="totales"]',
      '[data-testid*="total"]',
    ];
    let totalText = '';
    for (const selector of totalSelectors) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim().replace(/\s+/g, ' ');
      if (text && /\$/.test(text)) {
        totalText = text;
        break;
      }
    }

    if (counterText || totalText) {
      return [counterText && `count=${counterText}`, totalText && `total=${totalText}`].filter(Boolean).join(' | ');
    }

    return 'Cart summary not found';
  });
}

async function getCartItemCount(page) {
  return page.evaluate(() => {
    const candidates = [
      '[data-testid="carrito-badge"] [class*="cantidad-added"]',
      '[data-testid="carrito-badge"] #carrito-badge-counter',
      '[class*="cantidad-added__carrito"]',
      '[data-testid="carrito-badge"]',
    ];
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const raw = (element.innerText || element.textContent || '').trim();
      if (!raw) continue;
      const number = raw.match(/\d+/);
      if (number) return Number(number[0]);
    }
    return 0;
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
