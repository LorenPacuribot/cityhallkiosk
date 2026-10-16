// Step 1: read the charter PDF with pdf.js and save, per page, every text run with its position
// and every table border line. usage: node extract.js <charter.pdf> <items.json> <rules.json>
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { getRules } = require('./rules.js');

(async () => {
  const [pdfPath, itemsPath, rulesPath] = process.argv.slice(2);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), verbosity: 0 }).promise;
  const pages = [], rules = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    // y is measured from the top of the page; h is the font size
    const items = tc.items.filter(it => it.str && it.str.trim()).map(it => {
      const [, , c, d, e, f] = it.transform;
      return { s: it.str, x: +e.toFixed(1), y: +(vp.height - f).toFixed(1), w: +it.width.toFixed(1), h: +Math.hypot(c, d).toFixed(1) };
    });
    pages.push({ n, w: vp.width, h: vp.height, items });
    rules.push(await getRules(page));
    page.cleanup();
  }
  fs.writeFileSync(itemsPath, JSON.stringify(pages));
  fs.writeFileSync(rulesPath, JSON.stringify(rules));
  console.log(`extract: ${pages.length} pages, ${pages.reduce((a, p) => a + p.items.length, 0)} text runs`);
})();
