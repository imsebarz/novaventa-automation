// Quick DOM inspection helper. Reuses the same browser profile as script.js,
// navigates to a few key pages, and dumps relevant HTML so we can identify
// the new selectors after Novaventa's redesign.
//
// Usage:
//   node inspect.js
//
// Output: writes `inspect-output.json` next to this file.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const officeUrl = 'https://oficinavirtual.novaventa.com/';
const browserProfileDir = path.join(__dirname, '.browser-profile-office');
const outputPath = path.join(__dirname, 'inspect-output.json');
const sampleCode = process.argv[2] || '49774';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: browserProfileDir,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 1366, height: 900 });

  const report = {};

  try {
    console.log(`Opening ${officeUrl}`);
    await page.goto(officeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);

    report.home = await dumpPage(page, 'home');

    const searchUrl = `${officeUrl}BUSQUEDA?query=${encodeURIComponent(sampleCode)}`;
    console.log(`Opening search ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(8000);

    report.search = await dumpPage(page, `search:${sampleCode}`);
    report.search.productCards = await page.evaluate(() => {
      const cardSelectors = [
        'article',
        'div[class*="tarjeta"]',
        'div[class*="card"]',
        'div[class*="producto"]',
        'div[class*="product"]',
        'li[class*="producto"]',
      ];
      const seen = new Set();
      const cards = [];
      for (const selector of cardSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          const text = (element.innerText || '').trim();
          if (!text || text.length < 10) continue;
          if (cards.length >= 6) break;
          cards.push({
            selector,
            tag: element.tagName.toLowerCase(),
            className: element.className?.toString() || '',
            dataAttrs: Object.fromEntries(
              [...element.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => [attr.name, attr.value])
            ),
            text: text.slice(0, 400),
            buttons: [...element.querySelectorAll('button')].slice(0, 6).map(button => ({
              text: (button.textContent || '').trim().slice(0, 80),
              className: button.className?.toString() || '',
              disabled: button.disabled,
              dataAttrs: Object.fromEntries(
                [...button.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => [attr.name, attr.value])
              ),
            })),
            inputs: [...element.querySelectorAll('input')].slice(0, 6).map(input => ({
              type: input.type,
              name: input.name,
              value: input.value,
              placeholder: input.placeholder,
              className: input.className?.toString() || '',
            })),
            outerHTMLSnippet: element.outerHTML.slice(0, 1500),
          });
          if (cards.length >= 6) break;
        }
        if (cards.length >= 6) break;
      }
      return cards;
    });
    report.search.exactMatchDebug = await page.evaluate(searchedCode => {
      const cards = [...document.querySelectorAll('[class*="product-item-card"]')];
      const exactCl = new RegExp(`^CL:\\s*${searchedCode}(?!\\d)`, 'i');
      const rows = cards.map((card, index) => ({
        index,
        clTexts: [...card.querySelectorAll('[class*="__cl"], label')]
          .map(node => (node.textContent || '').trim())
          .filter(text => /^CL:/i.test(text)),
      }));
      return {
        cardCount: cards.length,
        regexSource: exactCl.source,
        match: rows.find(row => row.clTexts.some(text => exactCl.test(text))) || null,
        firstRows: rows.slice(0, 5),
      };
    }, sampleCode);

    // Variant products expose "Elegir tono" in the listing and only become
    // addable on the PDP. Inspect that route without clicking Agregar.
    report.variant = await page.evaluate(searchedCode => {
      const cards = [...document.querySelectorAll('[class*="product-item-card"]')];
      const card = cards.find(element => element.innerText?.includes(`CL: ${searchedCode}`));
      const action = [...(card?.querySelectorAll('button') || [])].find(button =>
        /^\s*Elegir\s+(tono|color|talla|opci[oó]n)\s*$/i.test(button.textContent || '')
      );
      const link = card?.querySelector('a[href*="/p"]');
      return action && link
        ? { action: (action.textContent || '').trim(), href: link.getAttribute('href') || '' }
        : null;
    }, sampleCode);

    if (report.variant?.href) {
      const variantUrl = new URL(report.variant.href, officeUrl).toString();
      console.log(`Opening variant PDP ${variantUrl}`);
      await page.goto(variantUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(8000);
      report.variant.pdp = await dumpPage(page, `variant-pdp:${sampleCode}`);
      report.variant.pdpState = await page.evaluate(searchedCode => {
        const isVisible = element => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const buttons = [...document.querySelectorAll('button')]
          .filter(isVisible)
          .map(button => ({
            text: (button.innerText || button.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
            disabled: button.disabled,
            className: button.className?.toString() || '',
            selectedAlt: button.querySelector('img[alt]')?.getAttribute('alt') || '',
          }));
        const selectedOptions = buttons.filter(button => /option--selected/.test(button.className));
        const inputs = [...document.querySelectorAll('input')]
          .filter(isVisible)
          .map(input => ({
            type: input.type,
            value: input.value,
            disabled: input.disabled,
            testid: input.getAttribute('data-testid') || '',
          }));
        return {
          url: location.href,
          exactCodeVisible: new RegExp(`CL:\\s*${searchedCode}\\b`).test(document.body?.innerText || ''),
          buttons,
          selectedOptions,
          inputs,
        };
      }, sampleCode);
    }

    // Open the real cart badge. Generic text matching can hit the
    // "OFICINA VIRTUAL / PEDIDO CICLO" navigation tab instead.
    const cartButton = await page.evaluate(() => {
      const badge = document.querySelector('[data-testid="carrito-badge"]');
      if (badge) {
        const button =
          badge.closest('button, a, [role="button"]') ||
          badge.querySelector('button, a, [role="button"]') ||
          badge;
        button.scrollIntoView({ block: 'center' });
        button.click();
        return {
          text: (button.textContent || '').trim().slice(0, 120),
          tag: button.tagName.toLowerCase(),
          className: button.className?.toString() || '',
        };
      }
      return null;
    });
    report.cartButton = cartButton;
    await sleep(4000);

    report.cart = await dumpPage(page, 'cart');
    report.cart.drawerHtml = await page.evaluate(() => {
      const candidates = [
        '[class*="carrito-popover"]',
        '[class*="carrito-container"]',
        '[role="dialog"]',
      ];
      for (const selector of candidates) {
        for (const element of document.querySelectorAll(selector)) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return element.outerHTML.slice(0, 100000);
        }
      }
      return '';
    });
    report.cart.cartItems = await page.evaluate(() => {
      const candidates = [
        'div[class*="carrito"] *',
        'div[class*="cart"] *',
        'aside *',
      ];
      const found = [];
      for (const selector of candidates) {
        for (const element of document.querySelectorAll(selector)) {
          const text = (element.innerText || '').trim();
          if (!text || text.length < 6 || text.length > 400) continue;
          if (!/\$|cantidad|unidad|eliminar|x\s*\d|CL:|código/i.test(text)) continue;
          found.push({
            selector,
            tag: element.tagName.toLowerCase(),
            className: element.className?.toString() || '',
            text: text.slice(0, 240),
          });
          if (found.length >= 20) return found;
        }
      }
      return found;
    });
    report.cart.lines = await page.evaluate(() => {
      const isVisible = element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll('article[class*="producto-carrito-layout_producto"]')]
        .filter(isVisible)
        .map(article => {
          const clText = article.querySelector('[class*="producto-carrito-info_detalle__cl"]')?.textContent || '';
          const code = clText.match(/CL:\s*(\d+)/i)?.[1] || '';
          const input = article.querySelector('input[data-testid="numeric-up-down-input"], input[type="number"]');
          return {
            code,
            quantity: Number(input?.value || 0),
            name: article.querySelector('[class*="descripcion"]')?.textContent?.trim().replace(/\s+/g, ' ') || '',
          };
        })
        .filter(line => line.code);
    });

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`Inspection report saved to ${outputPath}`);
  } catch (error) {
    console.error('Inspection failed:', error);
    fs.writeFileSync(outputPath, JSON.stringify({ error: error.message, partial: report }, null, 2));
  } finally {
    await browser.close();
  }
})();

async function dumpPage(page, label) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const visibleText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  const interestingElements = await page.evaluate(() => {
    const interestingSelectors = [
      '[data-testid]',
      '[id*="carrito"]',
      '[class*="carrito"]',
      '[class*="cart"]',
      '[class*="buscador"]',
      '[class*="search"]',
      '[class*="header"]',
      '[class*="nav"]',
      '[class*="badge"]',
      '[class*="pedido"]',
      'input[type="search"]',
      'input[placeholder*="Buscar"]',
    ];
    const seen = new Set();
    const elements = [];
    for (const selector of interestingSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        const text = (element.innerText || '').trim();
        elements.push({
          selector,
          tag: element.tagName.toLowerCase(),
          className: element.className?.toString() || '',
          id: element.id || '',
          dataAttrs: Object.fromEntries(
            [...element.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => [attr.name, attr.value])
          ),
          placeholder: element.placeholder || '',
          ariaLabel: element.getAttribute('aria-label') || '',
          text: text.slice(0, 240),
        });
        if (elements.length >= 60) return elements;
      }
    }
    return elements;
  });

  return { label, url, title, visibleText, interestingElements };
}
