// Step 2: table-aware parser for the Malaybalay 2023 Citizen's Charter.
// Every text run is placed in the table cell drawn around it (from the PDF's border lines), then cells are mapped
// to fields by their labels and column headers. Rows cut by a page break are joined; nothing in a table is dropped
// (cells that fit no field are kept as notes).
// usage: node parse.js <items.json> <rules.json> <parsed.json> <report.json>
const fs = require('fs');
const [itemsPath, rulesPath, outPath, reportPath] = process.argv.slice(2);
const PAGES = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
const RULES = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

// ------------------------------------------------------------------ text helpers
const BULLETS = '-•▪●◦‣⁃➢✓✔·■□';
const PUA = new RegExp(`[${BULLETS}]`, 'g'); // bullet glyphs (incl. Wingdings private-use characters)
const STARTS_WITH_BULLET = new RegExp(`^[${BULLETS}]`);
function cleanText(s) { // straight quotes, single spaces; line breaks (list items) are kept
  return s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/ /g, ' ')
    .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}
// Join text runs into lines, then lines into text. Runs closer than ~1.2pt join without a space ("E"+"very").
function joinItems(items, { keepLines = false, valueLines = false } = {}) {
  const maxH = Math.max(...items.map(i => i.h));
  const isSup = it => it.h <= maxH * 0.75; // superscripts ("2nd", "4th") are smaller and sit higher
  const sorted = [...items].filter(i => !isSup(i)).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2.5, it.h * 0.35)) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const it of items.filter(isSup)) { // attach to the line it is raised above
    const line = lines.filter(l => l.y >= it.y - 1 && l.y - it.y < maxH * 0.8).sort((a, b) => a.y - b.y)[0];
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => a.y - b.y);
  const texts = lines.map(l => {
    l.items.sort((a, b) => a.x - b.x);
    let s = '', end = null;
    for (const it of l.items) {
      if (end !== null) {
        const gap = it.x - end;
        if (gap > 1.2 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' ';
      }
      s += it.s; end = it.x + it.w;
    }
    s = s.replace(/\s+/g, ' ').trim();
    // a bullet glyph at the start of a line becomes "• "; anywhere else it is dropped
    const bullet = STARTS_WITH_BULLET.test(s);
    s = s.replace(PUA, ' ').replace(/\s+/g, ' ').trim();
    return bullet && s ? '• ' + s : s;
  }).filter(Boolean);
  if (keepLines) return texts;
  // a fee/time cell listing one value per line ("5 Minutes" / "3 Minutes") keeps one value per line
  if (texts.length > 1 && texts.every(t => VALUE_LINE.test(t))) return cleanText(texts.join('\n'));
  let out = '';
  for (const t of texts) {
    if (!out) out = t;
    else if (LIST_ITEM.test(t)) out += '\n' + t;                                       // list items keep their own line
    else if (/[A-Za-z]-$/.test(out) && !/-\s*$/.test(out.slice(0, -1))) out += t; // word broken across lines: "Lying-" + "In"
    else out += ' ' + t;
  }
  // a bullet set further along a line (two short items side by side) still starts its own line
  return cleanText(out.replace(/ (?=• )/g, '\n'));
}
// "• x", "1. X", "1) X", "a. X", "ii. X", "- X" at the start of a line (followed by a capital, so "12) and" is not one),
// and sub-headings such as "For Death of Spouse" in requirement lists
const LIST_ITEM = /^(• |[-–] (?=\S)|(\d{1,2}|[a-z]|[ivx]{1,4})[.)] *(?=[A-Z("'“])|For (?=[A-Z]))/;
const VALUE_LINE = /^(None|N\/?A|Free|Not applicable|(PHP|P|Php) ?[\d,]+(\.\d{2})?|\d+(\.\d+)? ?(Minutes?|Mins?\.?|Hours?|Hrs?\.?|(Working |Calendar )?Days?|Weeks?|Months?|Seconds?))$/i;

// ------------------------------------------------------------------ cells from table borders
function cellOf(pageIdx, it) {
  const { h, v } = RULES[pageIdx];
  const px = it.x + Math.min(3, it.w / 2), py = it.y - it.h * 0.35;
  let top = null, bottom = null, left = null, right = null;
  for (const l of h) if (l.x1 - 1.5 <= px && px <= l.x2 + 1.5) {
    if (l.y < py && (top === null || l.y > top)) top = l.y;
    if (l.y > py && (bottom === null || l.y < bottom)) bottom = l.y;
  }
  for (const l of v) if (l.y1 - 1.5 <= py && py <= l.y2 + 1.5) {
    if (l.x < px && (left === null || l.x > left)) left = l.x;
    if (l.x > px && (right === null || l.x < right)) right = l.x;
  }
  if ([top, bottom, left, right].some(x => x === null)) return null;
  return { top, bottom, left, right };
}
const pageCellCache = new Map();
function pageCells(pi) {
  if (pageCellCache.has(pi)) return pageCellCache.get(pi);
  const groups = new Map();
  for (const it of PAGES[pi].items) {
    const c = cellOf(pi, it);
    if (!c) continue;
    const key = `${c.top}|${c.bottom}|${c.left}|${c.right}`;
    if (!groups.has(key)) groups.set(key, { page: pi, ...c, items: [] });
    groups.get(key).items.push(it);
  }
  const cells = [...groups.values()].map(c => ({ ...c, text: joinItems(c.items), lines: joinItems(c.items, { keepLines: true }) }))
    .filter(c => c.text).sort((a, b) => a.top - b.top || a.left - b.left);
  pageCellCache.set(pi, cells);
  return cells;
}

// ------------------------------------------------------------------ service titles (14pt, numbered, left margin)
function findTitles() {
  const titles = [];
  for (let pi = 0; pi < PAGES.length; pi++) {
    // 14pt runs on lines that start at the left margin (the office-hours block is 14pt too but sits far right)
    const all14 = PAGES[pi].items.filter(i => i.h >= 13.5);
    const starts = all14.filter(i => i.x < 120);
    const big = all14.filter(i => starts.some(s => Math.abs(s.y - i.y) <= 3 || (i.x < 120)));
    if (!big.length) continue;
    const lines = joinItems(big, { keepLines: true });
    // keep y of each line
    const byY = [...big].sort((a, b) => a.y - b.y);
    const ys = []; for (const it of byY) if (!ys.length || Math.abs(ys[ys.length - 1] - it.y) > 3) ys.push(it.y);
    for (let k = 0; k < lines.length; k++) {
      const m = lines[k].match(/^(\d{1,3})\s*\.\s*(.+)$/);
      if (!m) continue;
      let title = m[2];
      // a title can wrap onto the next 14pt line(s)
      let j = k + 1;
      while (j < lines.length && !/^\d{1,3}\s*\./.test(lines[j]) && ys[j] - ys[j - 1] < 22) { title += ' ' + lines[j]; j++; }
      titles.push({ page: pi, y: ys[k], number: +m[1], title: cleanText(title) });
    }
  }
  // titles that are a table row (12pt) directly above the "Description of Service" row
  for (let pi = 0; pi < PAGES.length; pi++) {
    const cells = pageCells(pi);
    for (const d of cells.filter(c => /^Description of (the )?Services?/i.test(c.text))) {
      if (titles.some(t => t.page === pi && t.y < d.top + 2 && d.top - t.y < 70)) continue;
      const above = cells.filter(c => Math.abs(c.bottom - d.top) < 3 && c.left <= d.left + 2).sort((a, b) => b.right - a.right)[0];
      const m = above && above.text.match(/^(\d{1,3})\s*\.\s*(.+)$/);
      if (m) titles.push({ page: pi, y: above.top + 2, number: +m[1], title: cleanText(m[2]), fromCell: true });
      else titles.push({ page: pi, y: d.top - 1, number: null, title: '', missingTitle: true });
    }
  }
  titles.sort((a, b) => a.page - b.page || a.y - b.y);
  // a title inside a table cell: use the whole cell text (keeps superscripts such as "2nd", "4th")
  for (const t of titles) {
    if (t.fromCell || t.missingTitle) continue;
    const cell = pageCells(t.page).find(c => c.top <= t.y && c.bottom >= t.y - 2 && /^\d{1,3}\s*\.\s*\S/.test(c.text.replace(/^.*\n/, '')));
    const m = cell && cell.text.replace(/\n/g, ' ').match(/(\d{1,3})\s*\.\s*(.+)$/);
    if (m && +m[1] === t.number) t.title = cleanText(m[2]);
  }
  return titles;
}

// ------------------------------------------------------------------ parse one service
const LABELS = [
  ['description', /^Description of (the )?Services?\b/i],
  ['office_and_division', /^Office (and|or|\/|&) ?Division\b/i],
  ['classification', /^Classification\b/i],
  ['transaction_type', /^Type of Transaction\b/i],
  ['who_may_avail', /^Who May Avail\b/i],
  ['total_processing_time', /^Total Processing Time\b/i],
  ['total_fees', /^Total Fees( to be Paid)?\b/i],
  ['period_of_extension', /^Period of Extension\b/i],
];
const NOTE_RE = /^(Note|Notes|Policy|Reminder|\*)/i;
const overlapY =(a, b) => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const overlapX = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));

function parseService(t, next) {
  const issues = [];
  // cells in the service's region, in reading order
  const cells = [];
  // the last service ends before the office directory at the back of the charter
  let lastPage = next ? next.page : Math.min(PAGES.length - 1, t.page + 40);
  if (!next) for (let pi = t.page + 1; pi <= lastPage; pi++) if (pageCells(pi).some(c => /^Contact Information$/i.test(c.text))) { lastPage = pi - 1; break; }
  for (let pi = t.page; pi <= lastPage; pi++) {
    for (const c of pageCells(pi)) {
      if (pi === t.page && c.bottom <= t.y) continue;
      if (next && pi === next.page && c.bottom > next.y - 3) continue; // the next title (and anything below it)
      cells.push(c);
    }
  }
  const out = { number: t.number, title: t.title, source_page: t.page + 1 };

  // ---- header fields
  const used = new Set();
  for (const [key, re] of LABELS) {
    const lab = cells.find(c => re.test(c.text) && !used.has(c));
    if (!lab) { out[key] = ''; issues.push(`missing label ${key}`); continue; }
    used.add(lab);
    const vals = cells.filter(c => c.page === lab.page && Math.abs(c.left - lab.right) < 3 && overlapY(c, lab) > 2);
    let val = vals.map(c => c.text).join(' ');
    // text written under the label inside the label cell is part of the value too
    const extra = lab.text.replace(re, '').replace(/^[:\s]+/, '');
    if (extra) { val = val ? `${val}\n${extra}` : extra; issues.push(`label cell holds text: ${key}`); }
    vals.forEach(c => used.add(c));
    out[key] = cleanText(val);
  }

  // ---- requirements table
  const reqHead = cells.find(c => /^(Documentary Requirements|Checklist of Requirements)/i.test(c.text));
  const whereHead = cells.find(c => /^Where to Secure/i.test(c.text));
  const stepHead = cells.find(c => /^Client Action/i.test(c.text) || /^CLIENT STEPS/i.test(c.text));
  const idxOf = c => cells.indexOf(c);
  out.requirements = [];
  if (reqHead && whereHead) {
    const body = cells.slice(idxOf(reqHead) + 1, stepHead ? idxOf(stepHead) : cells.length).filter(c => c !== whereHead && !used.has(c));
    const reqCol = { left: reqHead.left, right: reqHead.right }, whereCol = { left: whereHead.left, right: whereHead.right };
    const reqCells = [], whereCells = [], heads = [];
    for (const c of body) {
      const oR = overlapX(c, reqCol), oW = overlapX(c, whereCol);
      if (oR > 5 && oW > 5) heads.push(c); else if (oR >= oW) reqCells.push(c); else whereCells.push(c);
    }
    const rows = [];
    for (const c of [...reqCells, ...heads].sort((a, b) => a.page - b.page || a.top - b.top)) {
      if (heads.includes(c)) { rows.push({ heading: true, cell: c, text: c.text, where: [] }); continue; }
      rows.push({ cell: c, text: c.text, lines: c.lines, where: [] });
    }
    for (const w of whereCells) {
      const target = rows.filter(r => !r.heading && r.cell.page === w.page && overlapY(r.cell, w) > 2);
      if (target.length) target.forEach(r => r.where.push(w.text));
      else rows.push({ cell: w, text: '', where: [w.text], orphanWhere: true });
    }
    rows.sort((a, b) => a.cell.page - b.cell.page || a.cell.top - b.cell.top);
    // a row split across pages: continuation text at the top of the next page
    const merged = [];
    for (const r of rows) {
      const prev = merged[merged.length - 1];
      const firstOnPage = prev && prev.cell.page !== r.cell.page && !merged.some(m => m !== prev && m.cell.page === r.cell.page);
      if (prev && firstOnPage && !r.heading && !prev.heading && looksLikeContinuation(prev.text, r.text)) {
        prev.text = joinSentence(prev.text, r.text);
        if (r.where.length) prev.where = prev.where.length && r.where[0] && !looksLikeContinuation(prev.where.join(' '), r.where[0]) ? [...prev.where, ...r.where] : [joinSentence(prev.where.join(' '), r.where.join(' '))];
        continue;
      }
      if (r.orphanWhere && prev) { prev.where.push(...r.where); continue; }
      merged.push(r);
    }
    for (const r of merged) {
      const where = cleanText(r.where.filter(Boolean).join('; '));
      if (r.heading) out.requirements.push({ requirement: r.text, where_to_secure: '', heading: true });
      else if (r.text) out.requirements.push({ requirement: r.text, where_to_secure: where });
    }
  } else issues.push('no requirements table header');

  // ---- steps table
  out.steps = [];
  if (!stepHead) { issues.push('no steps table header'); return { out, issues, cellTexts: cells.map(c => c.text) }; }
  const headRow = cells.filter(c => c.page === stepHead.page && overlapY(c, stepHead) > 2);
  const headBottom = Math.max(...headRow.map(c => c.bottom));
  const COLS = [];
  for (const c of headRow) {
    if (headRow.some(o => o !== c && o.top >= c.bottom - 1 && o.left >= c.left - 1 && o.right <= c.right + 1)) continue; // parent of sub-headers
    const tx = c.text;
    const kind = /Client/i.test(tx) ? 'client' : /Agency/i.test(tx) ? 'agency' : /Fee/i.test(tx) ? 'fee'
      : /Operational Timeline.*Recommended/i.test(tx) ? 'tl_min' : /Operational Timeline.*Maximum/i.test(tx) ? 'tl_max'
      : /Minimum/i.test(tx) ? 'time_min' : /Maximum/i.test(tx) ? 'time_max' : /Processing|Timeline|Time/i.test(tx) ? 'time'
      : /Person/i.test(tx) ? 'person' : /Contact/i.test(tx) ? 'contact' : null;
    if (kind) COLS.push({ kind, left: c.left, right: c.right });
  }
  if (!COLS.find(c => c.kind === 'agency') || !COLS.find(c => c.kind === 'client')) { issues.push('steps header columns not recognised: ' + headRow.map(c => c.text).join(' | ')); return { out, issues, cellTexts: cells.map(c => c.text) }; }
  const colOf = c => {
    let best = null, bo = 0;
    for (const k of COLS) { const o = overlapX(c, k); if (o > bo) { bo = o; best = k; } }
    // a cell spans when it covers most of two or more header columns (notes, totals, schedules)
    const covered = COLS.filter(k => overlapX(c, k) >= 0.8 * (k.right - k.left));
    return covered.length > 1 ? { kind: 'span', cols: covered.map(k => k.kind) } : best;
  };
  const body = [];
  for (const c of cells.slice(idxOf(stepHead))) {
    if (headRow.includes(c)) continue;
    if (c.page === stepHead.page && c.top < headBottom - 1) continue;
    body.push(c);
  }
  // stop at End of Transaction
  let endIdx = body.findIndex(c => /^End of (the )?Transaction/i.test(c.text));
  if (endIdx < 0) issues.push('no End of Transaction');
  const tbody = endIdx >= 0 ? body.slice(0, endIdx) : body;
  // ---- classify body cells: total rows, notes, section headings, ordinary column cells
  const KINDS = ['client', 'agency', 'fee', 'time', 'time_min', 'tl_min', 'time_max', 'tl_max', 'person', 'contact'];
  const kindOf = new Map();
  out.notes = []; out.totals = [];
  const isTotalLabel = c => {
    const k = colOf(c)?.kind;
    return (k === 'span' || k === 'client' || k === 'agency') && (/^Total\b/i.test(c.text) && c.text.length < 40 || /^Time$/i.test(c.text));
  };
  for (const lab of tbody.filter(isTotalLabel)) {
    const rowCells = tbody.filter(c => c.page === lab.page && Math.abs(c.top - lab.top) < 2 && Math.abs(c.bottom - lab.bottom) < 2);
    rowCells.forEach(c => kindOf.set(c, 'total'));
    out.totals.push(Object.fromEntries(rowCells.map(c => [c === lab ? 'label' : colOf(c)?.kind, c.text])));
  }
  for (const c of tbody) {
    if (kindOf.has(c)) continue;
    const col = colOf(c);
    if (!col) { kindOf.set(c, 'ignore'); continue; }
    if (col.kind !== 'span') { kindOf.set(c, col.kind); continue; }
    const cols = col.cols;
    if (NOTE_RE.test(c.text)) { out.notes.push(c.text); kindOf.set(c, 'ignore'); }
    else if (cols.every(k => k === 'client' || k === 'agency')) kindOf.set(c, 'client');           // a client step with no agency action
    else if (!cols.includes('client') && !cols.includes('agency')) kindOf.set(c, cols[0]);          // e.g. person+contact merged
    else kindOf.set(c, 'section');                                                                 // full-width sub-heading
  }
  if (endIdx >= 0) for (const c of body.slice(endIdx + 1)) if (NOTE_RE.test(c.text)) out.notes.push(c.text);
  const byKind = k => tbody.filter(c => kindOf.get(c) === k);

  // ---- rows: anchored on agency cells; client-only and section cells make their own rows
  const newRow = (cell, extra = {}) => ({ cell, cells: Object.fromEntries(KINDS.map(k => [k, []])), ...extra });
  const rows = byKind('agency').map(c => { const r = newRow(c); r.cells.agency.push(c); return r; });
  for (const c of byKind('section')) rows.push(newRow(c, { section: c.text }));
  for (const kind of KINDS.filter(k => k !== 'agency')) {
    for (const c of byKind(kind)) {
      if (kind === 'client') { // client text cut by a page break continues at the top of the next page
        const clients = byKind('client');
        const firstOnPage = !clients.some(o => o.page === c.page && o.top < c.top);
        const prevClient = clients.filter(o => o.page < c.page).sort((a, b) => a.page - b.page || a.top - b.top).pop();
        const owner = prevClient && rows.find(r => r.cells.client.includes(prevClient));
        if (firstOnPage && owner && !/^\d+\s*\./.test(c.text) && looksLikeContinuation(prevClient.text, c.text)) {
          owner.cells.client.push(c); issues.push('client text continued on next page'); continue;
        }
      }
      // a merged cell spanning several agency rows belongs to the first of them
      const cand = rows.filter(r => !r.section && r.cell.page === c.page && overlapY(r.cell, c) > 2).sort((a, b) => a.cell.top - b.cell.top);
      let r = cand[0];
      if (!r && kind === 'client') { r = newRow(c); rows.push(r); }
      if (!r) r = rows.filter(x => !x.section && x.cell.page === c.page && x.cell.top <= c.top + 2).sort((a, b) => b.cell.top - a.cell.top)[0];
      if (!r) { // continuation of the last row on an earlier page
        r = rows.filter(x => !x.section && x.cell.page < c.page).sort((a, b) => b.cell.page - a.cell.page || b.cell.top - a.cell.top)[0];
        if (r) issues.push(`continued ${kind} from previous page`);
        else { issues.push(`orphan ${kind} cell: ${c.text.slice(0, 50)}`); continue; }
      }
      r.cells[kind].push(c);
    }
  }
  rows.sort((a, b) => a.cell.page - b.cell.page || a.cell.top - b.cell.top);

  // One agency cell holding several numbered sub-actions, beside several fee/time cells:
  // split by position, each sub-action going with the side cell next to its first line.
  const expanded = [];
  for (const r of rows) {
    const side = KINDS.filter(kk => kk !== 'agency' && kk !== 'client' && r.cells[kk].length > 1)
      .sort((a, b) => r.cells[b].length - r.cells[a].length)[0];
    const subs = !r.section && side && r.cells.agency.length === 1 ? subActions(r.cells.agency[0]) : [];
    if (subs.length > 1) {
      const sideCells = [...r.cells[side]].sort((a, b) => a.top - b.top);
      const bandOf = y => { const i = sideCells.findIndex(c => y >= c.top - 2 && y < c.bottom); return i >= 0 ? i : (y < sideCells[0].top ? 0 : sideCells.length - 1); };
      const groups = sideCells.map(() => []);
      for (const s of subs) groups[bandOf(s.y)].push(s.text);
      const first = groups.findIndex(g => g.length);
      groups.forEach((g, i) => {
        if (!g.length) return;
        const nr = newRow(r.cell, { agencyText: g.join(' ') });
        if (i === first) nr.cells.client = r.cells.client;
        for (const kk of KINDS.filter(x => x !== 'agency' && x !== 'client')) {
          const cs = [...r.cells[kk]].sort((a, b) => a.top - b.top);
          nr.cells[kk] = cs.length > 1 ? cs.filter(c => bandOf(c.top + 2) === i) : (i === first ? cs : []);
        }
        expanded.push(nr);
      });
      issues.push(`split agency cell by ${side}`);
    } else expanded.push(r);
  }
  const textOf = (r, kind) => kind === 'agency' && r.agencyText !== undefined ? r.agencyText
    : r.cells[kind].sort((a, b) => a.page - b.page || a.top - b.top).map(c => c.text).reduce((a, b) => joinSentence(a, b), '');

  // rows broken across a page: continuation text at the top of the next page has no step number
  const merged = [];
  for (const r of expanded) {
    const v = Object.fromEntries(KINDS.map(k => [k, textOf(r, k)]));
    const prev = merged[merged.length - 1];
    const firstOnPage = prev && !prev.section && !r.section && prev.cell.page !== r.cell.page && !merged.some(m => m.cell.page === r.cell.page);
    const numbered = /^\d+(\.\d+)*\.?\s/.test(v.client) || /^\d+(\.\d+)*\.?\s/.test(v.agency);
    if (firstOnPage && !numbered && (looksLikeContinuation(prev.v.agency, v.agency) || (!v.agency && looksLikeContinuation(prev.v.client, v.client)))) {
      for (const k of KINDS) if (v[k]) prev.v[k] = prev.v[k] ? joinSentence(prev.v[k], v[k]) : v[k];
      issues.push('merged row continued on next page');
      continue;
    }
    merged.push({ cell: r.cell, section: r.section, v });
  }
  // group into client steps
  for (const r of merged) {
    if (r.section) { out.steps.push({ client_action: cleanText(r.section), agency_actions: [], section: true }); continue; }
    const v = r.v;
    // keep the leading number when the cell lists several numbered sub-actions ("1.1. … 1.2. …")
    const multi = s => (cleanText(s).match(/(?:^|\s)\d+\.\d+\.?\s/g) || []).length > 1;
    const client = stripNum(v.client), agency = multi(v.agency) ? cleanText(v.agency) : stripNum(v.agency);
    let time = v.time;
    if (!time && (v.time_min || v.time_max)) time = [v.time_min && `Minimum: ${v.time_min}${v.tl_min ? ` (${v.tl_min})` : ''}`, v.time_max && `Maximum: ${v.time_max}${v.tl_max ? ` (${v.tl_max})` : ''}`].filter(Boolean).join('; ');
    const act = { agency_action: agency, fee: cleanText(v.fee), time: cleanText(time), person: cleanText(v.person) };
    const last = out.steps[out.steps.length - 1];
    if (last && last.section && !client) { // a sub-heading row followed by actions with no client text: the heading names the step
      last.section = false; last.agency_actions.push(act);
    } else if (last && last.section && client) { // "If for printed IEC material," + "Provide Data"
      last.section = false; last.client_action = `${last.client_action.replace(/[\s,:;]+$/, '')}: ${client}`; last.agency_actions.push(act);
    } else if (client || !last || last.section) out.steps.push({ client_action: client, agency_actions: [act] });
    else last.agency_actions.push(act);
  }

  // ---- anything else inside the service's tables (fee schedules, cost tables, extra notes) is kept as notes,
  // one line per table row with cells separated by " | ", so no charter text is dropped.
  const consumed = new Set(used);
  const firstLabel = Math.min(...[...used].map(idxOf).filter(i => i >= 0));
  cells.forEach((c, i) => { if (i < firstLabel) consumed.add(c); });                              // title rows
  if (reqHead) cells.slice(idxOf(reqHead), idxOf(stepHead)).forEach(c => consumed.add(c));          // requirements table
  headRow.forEach(c => consumed.add(c));
  (endIdx >= 0 ? body.slice(0, endIdx + 1) : body).forEach(c => consumed.add(c));                  // steps table
  if (endIdx >= 0) body.slice(endIdx + 1).filter(c => NOTE_RE.test(c.text)).forEach(c => consumed.add(c));
  const rest = cells.filter(c => !consumed.has(c));
  const restRows = [];
  for (const c of rest) {
    const row = restRows.find(r => r.page === c.page && Math.abs(r.top - c.top) < 2);
    if (row) row.cells.push(c); else restRows.push({ page: c.page, top: c.top, cells: [c] });
  }
  for (const r of restRows) out.notes.push(r.cells.sort((a, b) => a.left - b.left).map(c => c.text).join(' | '));
  if (restRows.length) issues.push(`kept ${restRows.length} extra table rows as notes`);
  return { out, issues, cellTexts: cells.map(c => c.text) };
}
// Numbered sub-actions inside one agency cell ("1.1. ... 1.2. ..."), each with the y of its first line.
function subActions(cell) {
  const sorted = [...cell.items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2.5, it.h * 0.35)) last.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  const subs = [];
  for (const l of lines) {
    const text = joinItems(l.items);
    if (/^\d+\.\d+\.?\s/.test(text) || !subs.length) subs.push({ y: l.y - l.items[0].h * 0.35, text });
    else subs[subs.length - 1].text = joinSentence(subs[subs.length - 1].text, text);
  }
  return subs.filter(s => /^\d+\.\d+\.?\s/.test(s.text)).length > 1 ? subs : [];
}
function nearestRowAbove(rows, c) {
  const same = rows.filter(r => r.cell.page === c.page && r.cell.top <= c.top + 2).sort((a, b) => b.cell.top - a.cell.top);
  return same[0] || null;
}
const stripNum = s => cleanText(s.replace(/^\s*\d+(\s*\.\s*\d+)*\s*\.?\s*(?=\S)/, ''));
function looksLikeContinuation(prev, next) {
  if (!prev || !next) return false;
  if (/^[a-z(,;]/.test(next)) return true;                          // next text starts mid-sentence
  const p = prev.trim();
  if ((p.match(/\(/g) || []).length > (p.match(/\)/g) || []).length) return true; // a bracket is still open
  if (/^• /.test(next) && (/\n• /.test(p) || /:$/.test(p))) return true;          // a bulleted list carries on
  if (/([,\-–(&/]|\b(the|and|or|of|for|to|a|an|in|on|at|by|with|from|as|is|are|be|per|its|their|his|her|if|that|which|when|where))$/i.test(prev.trim())) return true; // previous text stops mid-phrase
  return false;
}
function joinSentence(a, b) {
  if (!a) return b; if (!b) return a;
  if (/[A-Za-z]-$/.test(a)) return a + b;
  return a + (LIST_ITEM.test(b) ? '\n' : ' ') + b; // a list item or sub-heading keeps its own line
}

// ------------------------------------------------------------------ main
const titles = findTitles();
const services = [], report = [];
for (let i = 0; i < titles.length; i++) {
  const { out, issues, cellTexts } = parseService(titles[i], titles[i + 1]);
  services.push(out); report.push({ n: i, page: out.source_page, title: out.title, issues, cellTexts });
}
fs.writeFileSync(outPath, JSON.stringify({ titles: titles.length, services }, null, 1));
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.log('titles', titles.length, 'services with issues', report.filter(r => r.issues.length).length);
const counts = {}; for (const r of report) for (const s of r.issues) { const k = s.replace(/:.*/, ''); counts[k] = (counts[k] || 0) + 1; }
console.log(counts);
