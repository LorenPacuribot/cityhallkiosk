// Step 3: check the parsed services against the PDF. Lists words from the charter's tables that did not make it
// into any field, and fields that look cut off. usage: node verify.js <parsed.json> <report.json> <verify.json>
const fs = require('fs');
const [parsedPath, reportPath, outPath] = process.argv.slice(2);
const N = JSON.parse(fs.readFileSync(parsedPath, 'utf8')).services, R = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const BOILER = /^(Description of (the )?Services?|Office (and|or) Division|Classification|Type of Transaction|Who May Avail|Total Processing Time|Total Fees( to be Paid)?|Period of Extension|Documentary Requirements|Checklist of Requirements|Where to Secure|Client Action.*|Agency Action.*|Fees to be Paid|Processing Time|Person in-?\s?Charge.*|Contact Number|End of (the )?Transaction|Total|Time|Minimum Calendar.*|Maximum Calendar.*|Operational Timeline.*)$/i;
const tok = s => (s.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9ñ']+/g) || []).filter(w => w.length > 1 || /\d/.test(w));
const fieldsOf = s => [s.title, s.description, s.office_and_division, s.classification, s.transaction_type, s.who_may_avail, s.total_processing_time, s.total_fees, s.period_of_extension,
  ...s.requirements.flatMap(r => [r.requirement, r.where_to_secure]), ...s.steps.flatMap(st => [st.client_action, ...st.agency_actions.flatMap(a => [a.agency_action, a.fee, a.time, a.person])]),
  ...(s.notes || []), ...(s.totals || []).flatMap(t => Object.values(t))];
const DANGLING = /\b(the|and|or|of|for|to|a|an|in|with|by|from|on|at|as|is|are|be|per|its|their|his|her|&|-)$/i;
let lost = 0; const out = [];
N.forEach((s, i) => {
  const have = new Map(); for (const w of tok(fieldsOf(s).join(' '))) have.set(w, (have.get(w) || 0) + 1);
  const missing = [];
  for (const c of R[i].cellTexts) {
    if (BOILER.test(c.trim())) continue;
    for (const w of tok(c)) { const n = have.get(w) || 0; if (n > 0) have.set(w, n - 1); else missing.push(w); }
  }
  // step numbers are stripped on purpose and contact numbers are not stored, so pure numbers don't count
  const realMissing = missing.filter(w => !/^\d+$/.test(w));
  const flags = [];
  const check = (name, v) => {
    if (!v) return; const t = v.trim();
    if (DANGLING.test(t) && t.length > 3) flags.push(`${name} ends mid-sentence: …${t.slice(-50)}`);
    if (/^[a-z]/.test(t) && !/^(e\.g|i\.e|c\/o)/i.test(t)) flags.push(`${name} starts lowercase: ${t.slice(0, 50)}…`);
  };
  check('description', s.description); check('who_may_avail', s.who_may_avail); check('total_fees', s.total_fees);
  s.requirements.forEach((r, k) => { check(`req${k + 1}`, r.requirement); check(`where${k + 1}`, r.where_to_secure); });
  s.steps.forEach((st, k) => { check(`step${k + 1}.client`, st.client_action); st.agency_actions.forEach((a, j) => { check(`step${k + 1}.${j + 1}.agency`, a.agency_action); check(`step${k + 1}.${j + 1}.person`, a.person); }); });
  lost += realMissing.length;
  if (realMissing.length || flags.length) out.push({ page: s.source_page, title: s.title, missing: realMissing, flags });
});
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`verify: ${N.length} services, ${out.length} with something to look at, ${lost} table words not in any field (see ${outPath})`);
