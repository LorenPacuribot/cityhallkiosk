// Re-import the Citizen's Charter PDF into server/data/charter-2023.json.
// usage: node import.js <charter.pdf>      then: cd ../../server && npm run seed
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pdf = process.argv[2];
if (!pdf || !fs.existsSync(pdf)) { console.error('usage: node import.js <path to the Citizen\'s Charter PDF>'); process.exit(1); }
const here = __dirname, cache = path.join(here, '.cache');
const target = path.join(here, '..', '..', 'server', 'data', 'charter-2023.json');
fs.mkdirSync(cache, { recursive: true });
const c = f => path.join(cache, f);
const step = (script, ...args) => execFileSync(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });

step('extract.js', pdf, c('items.json'), c('rules.json'));
step('parse.js', c('items.json'), c('rules.json'), c('parsed.json'), c('report.json'));
step('verify.js', c('parsed.json'), c('report.json'), c('verify.json'));
// offices come from the current data file (and the TOC kept in it); new services take the office of their neighbours
step('finalize.js', c('parsed.json'), target, c('charter-2023.json'));
fs.copyFileSync(c('charter-2023.json'), target);
console.log(`\nWrote ${path.relative(process.cwd(), target)}. Load it with: cd server && npm run seed`);
