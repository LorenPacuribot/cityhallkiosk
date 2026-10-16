// Step 4: turn parser output into the shape server/src/seed.js reads, assigning each service to its office.
// usage: node finalize.js <parsed.json> <current charter-2023.json> <out.json>
const fs = require('fs');
const [newPath, oldPath, outPath] = process.argv.slice(2);
const N = JSON.parse(fs.readFileSync(newPath, 'utf8')).services;
const O = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// office of each service: same page + similar title in the previous import, else the neighbour in the same numbered run
const office = N.map(s => (O.services.find(o => o.source_page === s.source_page && norm(o.title).slice(0, 15) === norm(s.title).slice(0, 15))
  || O.services.find(o => o.source_page === s.source_page))?.office || null);
const guessed = [];
N.forEach((s, i) => {
  if (office[i]) return;
  // numbering restarts at 1 for each office: look back while numbers keep increasing, else forward
  let j = i - 1; while (j >= 0 && !office[j]) j--;
  let k = i + 1; while (k < N.length && !office[k]) k++;
  const back = j >= 0 && N[j].number < s.number ? office[j] : null;
  const fwd = k < N.length && N[k].number > s.number ? office[k] : null;
  office[i] = back || fwd;
  guessed.push(`${s.source_page} #${s.number} ${s.title.slice(0, 60)} -> ${office[i]}`);
});

const services = N.map((s, i) => ({
  number: s.number,
  title: s.title,
  source_page: s.source_page,
  description: s.description,
  office_and_division: s.office_and_division,
  classification: s.classification,
  transaction_type: s.transaction_type,
  who_may_avail: s.who_may_avail,
  total_processing_time: s.total_processing_time,
  total_fees: s.total_fees,
  period_of_extension: s.period_of_extension,
  requirements: s.requirements.map(r => ({ requirement: r.requirement, where_to_secure: r.where_to_secure })),
  steps: s.steps.map(st => ({ client_action: st.client_action, agency_actions: st.agency_actions })),
  notes: (s.notes || []).join('\n'),
  parse_quality: 'good',
  office: office[i],
}));
const out = { source: O.source, parser: 'tools/charter (table-aware, pdf.js positions + table borders)', toc: O.toc, office_directory: O.office_directory, services };
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log('services', services.length, 'without office', services.filter(s => !s.office).length);
console.log('office assigned from neighbours:\n  ' + guessed.join('\n  '));
