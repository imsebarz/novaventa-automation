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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir);
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

  try {
    await loginOfficeVirtual(page);
    await chooseOfficeVirtualModeIfPrompted(page);
    await clearCart(page);

    for (const product of products) {
      const { code, quantity } = product;

      try {
        const productInfo = await searchProduct(page, code);

        if (!productInfo) {
          logger.warn(`Product code ${code} not found.`);
          errorProducts.push({ code, error: 'Product not found' });
          await takeScreenshot(page, `not_found_${code}.png`);
          continue;
        }

        const addedQuantity = await addToCart(page, productInfo, quantity);

        if (addedQuantity > 0) {
          successfulProducts.push({ ...productInfo, quantity: addedQuantity });
        }

        if (addedQuantity < quantity) {
          errorProducts.push({
            code,
            error: `Only added ${addedQuantity} of ${quantity} requested`,
          });
          await takeScreenshot(page, `partial_or_failed_add_${code}.png`);
        }
      } catch (productError) {
        logger.error(`Error processing product ${code}: ${productError.message}`);
        errorProducts.push({ code, error: productError.message });
        await takeScreenshot(page, `error_${code}.png`);
      }
    }

    await outputSummary(successfulProducts, errorProducts);
    logger.info(`Cart total: ${await getCartSummary(page)}`);
  } catch (error) {
    logger.error(`An unexpected error occurred: ${error.message}`);
    await takeScreenshot(page, 'unexpected_error.png');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

async function loginOfficeVirtual(page) {
  const username = process.env.NOVAVENTA_USERNAME;
  const password = process.env.NOVAVENTA_PASSWORD;

  logger.info('Opening Oficina Virtual order page.');
  await gotoOfficeOrder(page);

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Existing Oficina Virtual session detected.');
    return;
  }

  if (manualLogin) {
    await waitForManualStoreLogin(page);
    return;
  }

  if (!username || !password) {
    throw new Error('Missing NOVAVENTA_USERNAME or NOVAVENTA_PASSWORD in .env, or set NOVAVENTA_MANUAL_LOGIN=true');
  }

  await page.waitForSelector('input[data-testid="input-text"], input[type="text"]', {
    timeout: 60000,
  });

  await typeIntoFirstMatchingInput(page, 'input[data-testid="input-text"], input[type="text"]', username);
  await typeIntoFirstMatchingInput(page, 'input[data-testid="input-password"], input[type="password"]', password);

  logger.info('Submitting Oficina Virtual credentials.');
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }),
    clickButtonByText(page, /Inicia sesión/i),
  ]);

  await sleep(8000);

  if (!page.url().startsWith(officeUrl)) {
    logger.warn(`Oficina Virtual redirected outside office flow after login: ${page.url()}`);
    await gotoOfficeOrder(page);
  }

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Logged in to Oficina Virtual.');
    return;
  }

  const bodyText = await getVisibleText(page);
  const loginError = extractLoginError(bodyText);
  throw new Error(loginError || 'Could not log in to Oficina Virtual / realizar-pedido.');
}

async function waitForManualStoreLogin(page) {
  logger.info('Manual login mode enabled.');
  logger.info('Log in at novaventa.com, solve captcha if needed, and choose “Haz tu pedido en OFICINA VIRTUAL”.');

  await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
    logger.warn(`Store navigation did not finish cleanly, continuing with loaded DOM: ${error.message}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('\nWhen you are inside Oficina Virtual / realizar-pedido in the browser, press ENTER here to continue... ');
  } finally {
    rl.close();
  }

  if (!page.url().startsWith(officeUrl)) {
    logger.info('Current tab is not Oficina Virtual yet; opening realizar-pedido with the existing browser session.');
    await gotoOfficeOrder(page);
  }

  await chooseOfficeVirtualModeIfPrompted(page);

  if (await isLoggedInOfficeVirtual(page)) {
    logger.info('Manual Oficina Virtual session detected. Continuing with products.');
    return;
  }

  throw new Error('Manual login was not detected. Make sure the browser is inside Oficina Virtual / realizar-pedido before pressing ENTER.');
}

async function gotoOfficeOrder(page) {
  await page.goto(officeOrderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
    logger.warn(`Navigation did not finish cleanly, continuing with loaded DOM: ${error.message}`);
  });
  await sleep(8000);
}

async function isLoggedInOfficeVirtual(page) {
  const text = await getVisibleText(page);
  const url = page.url();

  if (!url.startsWith(officeUrl)) return false;
  if (/Usuario o contraseña son incorrectos/i.test(text)) return false;
  if (/Inicia sesión con cédula y contraseña/i.test(text)) return false;

  return /Haz tu pedido|HACER MI PEDIDO|Realizar pedido|Mi negocio|Historial de pedidos|Cerrar sesión|Total pedido|Carrito|pedido/i.test(text);
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
  await openCartIfNeeded(page);

  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const cartSummary = await getCartSummary(page);

    if (isCartEmpty(cartSummary)) {
      logger.info(`Cart cleared: ${cartSummary}`);
      return;
    }

    const clicked = await page.evaluate(() => {
      const selectors = [
        'button[class*="producto-carrito_acciones__eliminar"]',
        'button[class*="eliminar"]',
        '[data-testid*="eliminar"]',
        '[data-testid*="trash"]',
      ];

      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button) {
          button.scrollIntoView({ block: 'center' });
          button.click();
          return true;
        }
      }

      const trashButton = [...document.querySelectorAll('button')].find(button =>
        /trash|eliminar|borrar|quitar/i.test(button.textContent || button.getAttribute('aria-label') || '')
      );
      if (!trashButton) return false;

      trashButton.scrollIntoView({ block: 'center' });
      trashButton.click();
      return true;
    });

    if (!clicked) {
      logger.info(`No delete button found. Cart summary: ${cartSummary}`);
      return;
    }

    await page
      .waitForResponse(
        response =>
          /carrito|pedido/i.test(response.url()) &&
          response.status() >= 200 &&
          response.status() < 300,
        { timeout: 15000 }
      )
      .catch(() => null);

    await sleep(1000);
  }

  throw new Error(`Could not clear cart. Last summary: ${await getCartSummary(page)}`);
}

function isCartEmpty(summary) {
  const compact = summary.replace(/\s+/g, '');
  return /\$0(?:\D|$)/.test(compact) || /(?:^|\D)0$/.test(compact) || /not found/i.test(summary);
}

async function ensureOfficeHome(page) {
  if (!page.url().startsWith(officeUrl) || !/realizar-pedido/i.test(page.url())) {
    await gotoOfficeOrder(page);
  }
}

async function openCartIfNeeded(page) {
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
    const cart = candidates.find(element => /carrito|pedido|total/i.test(element.textContent || element.getAttribute('aria-label') || ''));
    cart?.click();
  });
  await sleep(1500);
}

async function searchProduct(page, code) {
  logger.info(`Searching for product code: ${code}`);

  await ensureOfficeHome(page);

  const searchUrl = new URL('/BUSQUEDA', officeUrl);
  searchUrl.searchParams.set('query', code);
  await page.goto(searchUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
    logger.warn(`Search navigation did not finish cleanly, continuing with loaded DOM: ${error.message}`);
  });

  await page.waitForFunction(
    searchedCode => {
      const text = document.body.innerText;
      return (
        text.includes(`CL: ${searchedCode}`) ||
        /\d+ resultados|0 resultados|sin resultados|no encontramos|No encontramos/i.test(text)
      );
    },
    { timeout: 60000 },
    code
  );

  return await page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        'div[class*="product-for-grid_tarjeta"], article, div[class*="product-card"], div[class*="producto"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));

    if (!card) return null;

    const addButton = [...card.querySelectorAll('button')].find(button =>
      /Agregar|Añadir|Sumar|A tu pedido/i.test(button.textContent)
    );

    if (!addButton || addButton.disabled) {
      const actionButton = [...card.querySelectorAll('button')][0];
      const warning = getText(card, '[data-testid="product-warning"], [class*="warning"]');
      return {
        code: searchedCode,
        name: getText(card, '[class*="descripcion"], [class*="description"]'),
        brand: getText(card, '[class*="marca"], [class*="brand"]'),
        price: getText(card, '[class*="precio"], [class*="price"]'),
        canAdd: false,
        unavailableReason: warning || actionButton?.textContent.trim() || 'Add button not found',
      };
    }

    return {
      code: searchedCode,
      name: getText(card, '[class*="descripcion"], [class*="description"]'),
      brand: getText(card, '[class*="marca"], [class*="brand"]'),
      price: getText(card, '[class*="precio"], [class*="price"]'),
      canAdd: true,
    };

    function getText(root, selector) {
      return root.querySelector(selector)?.textContent.trim().replace(/\s+/g, ' ') || '';
    }
  }, code);
}

async function addToCart(page, productInfo, quantity) {
  if (!productInfo.canAdd) {
    logger.warn(`Product ${productInfo.code} cannot be added: ${productInfo.unavailableReason}`);
    return 0;
  }

  logger.info(
    `Found product: Code - ${productInfo.code}, Name - ${productInfo.name || 'N/A'}, Price - ${productInfo.price || 'N/A'}`
  );

  let addedQuantity = 0;

  for (let count = 1; count <= quantity; count += 1) {
    const cartCountBefore = await getCartItemCount(page);
    const clicked = await clickAddButton(page, productInfo.code);

    if (!clicked) break;

    await page
      .waitForResponse(
        response =>
          /carrito|pedido/i.test(response.url()) &&
          response.status() >= 200 &&
          response.status() < 300,
        { timeout: 30000 }
      )
      .catch(() => null);

    await sleep(1200);

    const cartCountAfter = await getCartItemCount(page);
    if (cartCountAfter > cartCountBefore) {
      addedQuantity += cartCountAfter - cartCountBefore;
      continue;
    }

    const warning = await getProductWarning(page, productInfo.code);
    logger.warn(`Product ${productInfo.code} did not increase cart quantity${warning ? `: ${warning}` : ''}`);
    break;
  }

  if (addedQuantity > 0) {
    logger.info(`Product ${productInfo.code} added to cart with quantity ${addedQuantity}.`);
  }

  return addedQuantity;
}

async function clickAddButton(page, code) {
  return page.evaluate(searchedCode => {
    const cards = [
      ...document.querySelectorAll(
        'div[class*="product-for-grid_tarjeta"], article, div[class*="product-card"], div[class*="producto"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
    const addButton = [...(card?.querySelectorAll('button') || [])].find(button =>
      /Agregar|Añadir|Sumar|A tu pedido/i.test(button.textContent)
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
        'div[class*="product-for-grid_tarjeta"], article, div[class*="product-card"], div[class*="producto"]'
      ),
    ];
    const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
    return (
      card
        ?.querySelector('[data-testid="product-warning"], [class*="warning"]')
        ?.textContent.trim().replace(/\s+/g, ' ') || ''
    );
  }, code);
}

async function getCartSummary(page) {
  return page.evaluate(() => {
    const selectors = [
      '[data-testid="carrito-badge"]',
      '[id*="carrito"]',
      '[class*="carrito"]',
      '[class*="mini-cart"]',
      '[class*="pedido"]',
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim().replace(/\s+/g, ' ');
      if (text && /(Total|pedido|carrito|\$|producto)/i.test(text)) return text;
    }

    return 'Cart summary not found';
  });
}

async function getCartItemCount(page) {
  return page.evaluate(() => {
    const badge = document.querySelector('[data-testid="carrito-badge"], [id*="carrito-badge"], [class*="carrito"]');
    const text = badge?.innerText || '';
    const numbers = text.match(/\b\d+\b/g) || [];
    return numbers.length ? Number(numbers[numbers.length - 1]) : 0;
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
