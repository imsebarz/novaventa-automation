// Import required modules
const puppeteer = require('puppeteer');
const dotenv = require('dotenv');
const winston = require('winston');
const fs = require('fs');
const path = require('path');


// Load environment variables from .env file
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(
      info => `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    // Uncomment the line below to enable file logging
    // new winston.transports.File({ filename: 'automation.log' }),
  ],
});

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir);
}

(async () => {
  // Retrieve credentials from environment variables
  const username = process.env.NOVAVENTA_USERNAME;
  const password = process.env.NOVAVENTA_PASSWORD;

  if (!username || !password) {
    logger.error('Username or password not set in environment variables.');
    process.exit(1);
  }

  // Array of products with codes and quantities
  const products = [
    { code: '35505', quantity: 1 },
    { code: '97213', quantity: 1 },
    { code: '36696', quantity: 1 },
    { code: '23401', quantity: 1 },
    { code: '37450', quantity: 1 },
    { code: '3695', quantity: 1 },
    { code: '36018', quantity: 1 },
    { code: '37975', quantity: 1 },
    { code: '97503', quantity: 2 },
    { code: '28830', quantity: 1 },
    { code: '7564', quantity: 1 },
    { code: '28936', quantity: 1 },
    { code: '20515', quantity: 1 },
    { code: '23784', quantity: 2 },
    { code: '7520', quantity: 1 },
    { code: '93689', quantity: 1 },
    { code: '93690', quantity: 1 },
    { code: '20488', quantity: 1 },
    { code: '14148', quantity: 1 },
    { code: '41657', quantity: 1 },
    { code: '41707', quantity: 1 },
    { code: '31178', quantity: 1 },
  ];

  // Arrays to collect successful and error products
  const successfulProducts = [];
  const errorProducts = [];

  // Launch the browser
  const browser = await puppeteer.launch({ headless: false }); // Set to true to run headless
  const page = await browser.newPage();

  try {
    // Perform login
    await login(page, username, password);

    // Iterate over each product
    for (const product of products) {
      const { code, quantity } = product;
      try {
        // Search for the product
        const productElement = await searchProduct(page, code);

        if (!productElement) {
          logger.warn(`Product code ${code} not found.`);
          errorProducts.push({ code, error: 'Product not found' });
          await takeScreenshot(page, `not_found_${code}.png`);
          continue;
        }

        // Add the product to the cart
        const added = await addToCart(page, productElement, code, quantity);

        if (added) {
          successfulProducts.push({ code, quantity });
        } else {
          errorProducts.push({ code, error: 'Failed to add to cart' });
        }
      } catch (productError) {
        logger.error(`Error processing product ${code}: ${productError.message}`);
        errorProducts.push({ code, error: productError.message });
        await takeScreenshot(page, `error_${code}.png`);
      }
    }

    // Output the summary
    await outputSummary(successfulProducts, errorProducts);
  } catch (error) {
    logger.error(`An unexpected error occurred: ${error.message}`);
  } finally {
    await browser.close();
  }
})();

/**
 * Logs into the Novaventa website using provided credentials.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} username - The username for login.
 * @param {string} password - The password for login.
 */
async function login(page, username, password) {
  logger.info('Navigating to the login page.');

  await page.goto(
    'https://comercio.novaventa.com.co/nautilusb2bstorefront/nautilus/es/COP/login',
    { waitUntil: 'networkidle2' }
  );

  logger.info('Entering login credentials.');
  await page.type('#j_username', username, { delay: 100 });
  await page.type('#j_password', password, { delay: 100 });

  logger.info('Submitting login form.');
  await Promise.all([
    page.click('#btn-login'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ]);

  logger.info('Logged in successfully.');
}

/**
 * Searches for a product by its code.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} code - The product code to search for.
 * @returns {puppeteer.ElementHandle|null} - The product element if found, else null.
 */
async function searchProduct(page, code) {
  logger.info(`Searching for product code: ${code}`);

  // Navigate to the homepage
  await page.goto(
    'https://comercio.novaventa.com.co/nautilusb2bstorefront/nautilus/es/COP/homepage',
    { waitUntil: 'networkidle2' }
  );

  // Use the search bar to search for the product
  await page.waitForSelector('#js-site-search-input');
  await page.click('#js-site-search-input', { clickCount: 3 });
  await page.type('#js-site-search-input', code);
  await Promise.all([
    page.keyboard.press('Enter'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ]);

  // Wait for search results or 'no results' message
  await page.waitForFunction(
    () =>
      document.querySelector('.cardproduct') ||
      document.querySelector('.search-empty'),
    { timeout: 10000 }
  );

  // Check if the 'search-empty' div is present
  const noResults = await page.$('.search-empty');
  if (noResults) {
    return null;
  }

  // Return the product element
  return await page.$('.cardproduct');
}

/**
 * Adds a product to the cart.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {puppeteer.ElementHandle} productElement - The product element.
 * @param {string} code - The product code.
 * @param {number} quantity - The quantity to add.
 * @returns {Promise<boolean>} - True if added successfully, else false.
 */
async function addToCart(page, productElement, code, quantity) {
  const productInfo = await page.evaluate(el => {
    const displayedCode = el
      .querySelector('.cardproduct__code .bold')
      ?.textContent.trim();
    const stockStatus = el.getAttribute('data-metriplica-prod-stock');
    const productName = el.querySelector('.cardproduct__name a')?.textContent.trim();
    return { displayedCode, stockStatus, productName };
  }, productElement);

  if (!productInfo) {
    logger.warn(`No product information found for code ${code}.`);
    return false;
  }

  const { displayedCode, stockStatus, productName } = productInfo;
  logger.info(
    `Found product: Code - ${displayedCode}, Name - ${productName}, Stock Status - ${stockStatus}`
  );

  if (stockStatus !== 'inStock') {
    logger.warn(`Product ${code} is unavailable.`);
    return false;
  }

  // Set the desired quantity
  const quantityInputSelector = 'input.qtyList';
  await page.waitForSelector(quantityInputSelector);
  await page.evaluate(
    (selector, qty) => {
      const qtyInput = document.querySelector(selector);
      qtyInput.value = '';
      qtyInput.value = qty;
      qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
    },
    quantityInputSelector,
    quantity.toString()
  );

  // Click the "Add to Cart" button
  await Promise.all([
    page.click('button.btn.btn-primary.btn-block.js-enable-btn'),
    page.waitForResponse(response => response.url().includes('/cart') && response.status() === 200),
  ]);

  logger.info(`Product ${code} added to cart with quantity ${quantity}.`);
  return true;
}

/**
 * Takes a screenshot of the current page.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} filename - The filename for the screenshot.
 */
async function takeScreenshot(page, filename) {
    const screenshotPath = path.join(screenshotsDir, filename);
    await page.screenshot({ path: screenshotPath });
    logger.info(`Screenshot saved: ${screenshotPath}`);
  }

/**
 * Outputs a summary of the operation.
 * @param {Array} successfulProducts - List of successfully added products.
 * @param {Array} errorProducts - List of products that encountered errors.
 */
async function outputSummary(successfulProducts, errorProducts) {
  logger.info('\nSummary:\n');

  if (successfulProducts.length > 0) {
    logger.info(
      `${successfulProducts.length} products successfully added to the cart:`
    );
    successfulProducts.forEach(product => {
      logger.info(`- Code: ${product.code}, Quantity: ${product.quantity}`);
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
