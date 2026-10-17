// Seeds the database: building, floors, rooms (placeholder coordinates), offices,
// office locations, the lobby kiosk, users, and all services imported from the
// 2023 Citizen's Charter (data/charter-2023.json).
//
//   npm run seed          -> wipes and rebuilds data/kiosk.sqlite
//
// IMPORTANT: room coordinates here are PLACEHOLDERS laid out on the 110 m x 40 m
// plan grid. Replace them by editing rooms in the admin panel. Real routes come from the published
// navigation graph (Admin > Navigation), not from these coordinates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, run, get, all, tx, saveNow, setSetting, ROOT } from './db.js';
import { hashPassword } from './auth.js';
import { OFFICE_LOGOS } from './lib/office-logos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FLOOR_H = 4.2; // metres between floors (assumption until elevations are measured)

// name in charter TOC -> placement
const OFFICES = [
  // ---- 1st floor (List of Offices, Charter p. 657–658)
  { name: 'Business Permit and Licensing Division', short: 'BPLD', floor: 1, room: ['1F-101', -18, 10, 10, 8] },
  { name: "City Treasurer's Office", short: 'CTO', floor: 1, room: ['1F-102', -27, 10, 8, 8] },
  { name: 'City Assessors Office', short: 'CASSO', floor: 1, room: ['1F-103', -35, 10, 8, 8] },
  { name: 'City Civil Registrar Office', short: 'CCRO', floor: 1, room: ['1F-104', -18, 22, 10, 8] },
  { name: 'City Urban Development and Housing Division', short: 'CUDHD', floor: 1, room: ['1F-105', -27, 22, 8, 8] },
  { name: 'City General Services Office', short: 'CGSO', floor: 1, room: ['1F-106', -35, 22, 8, 8] },
  { name: 'City Social Welfare and Development Office', short: 'CSWDO', floor: 1, room: ['1F-107', 18, 10, 10, 8] },
  { name: 'City Environment and Natural Resources Office', short: 'CENRO', floor: 1, room: ['1F-108', 27, 10, 8, 8] },
  // ---- 2nd floor
  { name: "City Mayor's Office", short: 'CMO', floor: 2, room: ['2F-201', -18, 10, 10, 8] },
  { name: 'City Administrator Office', short: 'CAdO', floor: 2, room: ['2F-202', -27, 10, 8, 8] },
  { name: 'City Human Resources Management Office', short: 'CHRMO', floor: 2, room: ['2F-203', -35, 10, 8, 8] },
  { name: 'City Legal Office', short: 'CLO', floor: 2, room: ['2F-204', -18, 22, 10, 8] },
  { name: 'City Planning and Development Office', short: 'CPDO', floor: 2, room: ['2F-205', -27, 22, 8, 8] },
  { name: 'City Budget Office', short: 'CBO', floor: 2, room: ['2F-206', 18, 10, 10, 8] },
  { name: "City Accountant's Office", short: 'CAcO', floor: 2, room: ['2F-207', 27, 10, 8, 8] },
  // ---- outside the New City Hall (per the Charter's List of Offices)
  { name: 'City Disaster Risk Reduction and Management Office', short: 'CDRRMO', offsite: 'Market Side, Barangay 9, Malaybalay City', phone: '(088) 813-3611' },
  { name: 'City Economic Enterprise Development and Management Office', short: 'CEEDMO', offsite: 'Market Side, Barangay 9, Malaybalay City', phone: '(088) 813-4759' },
  { name: 'City Health Office', short: 'CHO', offsite: 'Freedom Park, Barangay 4, Malaybalay City', phone: '(088) 813-0738' },
  { name: 'City Agriculture Office', short: 'CAgO', offsite: 'Barangay Casisang, Malaybalay City', phone: '(088) 813-1254' },
  { name: 'City Veterinary Office', short: 'CVO', offsite: 'Barangay Casisang, Malaybalay City', phone: '(088) 813-3205' },
  { name: "City Engineer's Office", short: 'CEO', offsite: 'Barangay Casisang, Malaybalay City', phone: '(088) 813-1695' },
  // ---- not in the Charter's List of Offices: location must be confirmed by the city
  { name: "City Vice Mayor's Office", short: 'CVMO', unconfirmed: true },
  { name: 'Public Employment Service Office', short: 'PESO', unconfirmed: true },
  { name: 'Office of the Senior Citizen Affairs', short: 'OSCA', unconfirmed: true },
  { name: 'Office of Building Official', short: 'OBO', unconfirmed: true },
  { name: 'Bids and Awards Committee', short: 'BAC', unconfirmed: true },
];

const PHONES = { BPLD: '(088) 813-2880', CTO: '(088) 813-3772', CASSO: '(088) 813-5704', CCRO: '(088) 813-5816', CUDHD: '(088) 813-7121', CGSO: '(088) 813-5639', CSWDO: '(088) 813-3054', CENRO: '(088) 813-2977', CMO: '(088) 813-5643', CAdO: '(088) 813-4707', CHRMO: '(088) 813-5545', CLO: '(088) 813-4706', CPDO: '(088) 813-2754', CBO: '(088) 813-5682', CAcO: '(088) 813-2940' };

// keyword rules: [regex on official title, keywords[], optional plain title]
const KEYWORDS = [
  [/community tax certificate/i, ['cedula', 'ctc', 'residence certificate', 'sedula'], 'Cedula (Community Tax Certificate)'],
  [/business permit/i, ['business permit', "mayor's permit", 'negosyo', 'permit renewal', 'bplo']],
  [/extracted copy of certificate of live birth/i, ['birth certificate', 'birth cert', 'copy of birth', 'marriage certificate', 'death certificate', 'local copy'], 'Copy of birth, marriage or death certificate'],
  [/birth registration|registration of certificate of live birth/i, ['register birth', 'birth registration', 'late registration', 'newborn']],
  [/marriage license/i, ['marriage license', 'kasal', 'wedding']],
  [/registration of marriage/i, ['marriage registration', 'kasal']],
  [/death/i, ['death certificate', 'death registration', 'patay']],
  [/correction|clerical error|change of first name/i, ['correction', 'wrong spelling', 'change name', 'ra 9048', 'ra 10172']],
  [/real property tax|amilyar/i, ['amilyar', 'rpt', 'land tax', 'property tax']],
  [/tax declaration/i, ['tax dec', 'td', 'land title', 'property']],
  [/landholding/i, ['landholding', 'no property certificate']],
  [/senior citizen/i, ['senior id', 'osca', 'senior citizen id', 'lolo', 'lola']],
  [/burial|financial assistance|educational assistance|medicine assistance|blood assistance/i, ['assistance', 'ayuda', 'tabang', 'help']],
  [/scholar/i, ['scholarship', 'scholar', 'iskolar']],
  [/building permit|occupancy/i, ['building permit', 'occupancy permit', 'construction']],
  [/health certificate|sanitary/i, ['health card', 'health certificate', 'sanitary permit']],
  [/clearance/i, ['clearance']],
  [/job|employment|peso/i, ['job', 'trabaho', 'employment', 'work']],
];

function isG2GOnly(t) {
  const s = (t || '').toLowerCase();
  if (!s) return false;
  const g2g = /government to government|g2g/.test(s);
  const citizen = /citizen|client|business|g2c|g2b|public|all/.test(s);
  return g2g && !citizen;
}

export async function seed({ reset = true } = {}) {
  if (reset) {
    for (const f of ['kiosk.sqlite', 'kiosk.sqlite.tmp']) {
      const p = path.join(ROOT, 'data', f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
  await openDb({ fresh: reset });
  const charter = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'charter-2023.json'), 'utf8'));

  tx(() => {
    setSetting('content_version', 1);
    setSetting('city_name', 'City Government of Malaybalay');
    setSetting('building_name', 'Malaybalay City Hall');
    setSetting('info_desk_hint', 'The information desk is to your left as you enter.');

    const b = run(`INSERT INTO buildings(code,name,address,origin_note) VALUES (?,?,?,?)`,
      ['NCH', 'New Malaybalay City Hall', 'Sayre Highway, Barangay Casisang, Malaybalay City, Bukidnon',
       'Origin (0,0,0) = centre of the main entrance doorway at ground level. +X = east (right when facing the building), +Z = into the building, +Y = up. 1 unit = 1 metre.']).lastId;
    const floorIds = {};
    for (const [lvl, name] of [[1, '1st floor'], [2, '2nd floor'], [3, '3rd floor']]) {
      floorIds[lvl] = run(`INSERT INTO floors(building_id,level,name,elevation_y,bounds_min_x,bounds_max_x,bounds_min_z,bounds_max_z) VALUES (?,?,?,?,?,?,?,?)`,
        [b, lvl, name, (lvl - 1) * FLOOR_H, -56, 56, -2, 40]).lastId;
    }
    const addRoom = (floor, code, name, type, x, z, w, d, extra = {}) => {
      const y = (floor - 1) * FLOOR_H;
      // front-row rooms (z < 16) open to the corridor at z = 16; back-row rooms too.
      const approachZ = extra.approachZ ?? (z < 16 ? z + d / 2 + 1.2 : z - d / 2 - 1.2);
      return run(`INSERT INTO rooms(floor_id,code,name,room_type,x,y,z,approach_x,approach_y,approach_z,facing_deg,width_m,depth_m,is_accessible,coord_source,notes)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'seed_placeholder', ?)`,
        [floorIds[floor], code, name, type, x, y, z, extra.approachX ?? x, y, approachZ, z < 16 ? 180 : 0, w, d,
         extra.accessible ?? (floor === 1 ? 1 : 0), extra.notes ?? 'Placeholder position on the plan grid — replace with the measured value.']).lastId;
    };
    // shared spaces
    addRoom(1, '1F-ENT', 'Main entrance', 'entrance', 0, 1, 8, 2, { approachZ: 2 });
    addRoom(1, '1F-INFO', 'Information desk', 'info_desk', -5, 8, 4, 3, { approachZ: 10.5 });
    addRoom(1, '1F-LOBBY', 'Main lobby', 'hall', 0, 12, 20, 14, { approachZ: 12 });
    for (const lvl of [1, 2, 3]) {
      addRoom(lvl, `${lvl}F-STW`, `West stairs (${['1st', '2nd', '3rd'][lvl - 1]} floor)`, 'stairs', -10, 24, 4, 6, { approachZ: 21, accessible: 0 });
      addRoom(lvl, `${lvl}F-STE`, `East stairs (${['1st', '2nd', '3rd'][lvl - 1]} floor)`, 'stairs', 10, 24, 4, 6, { approachZ: 21, accessible: 0 });
      addRoom(lvl, `${lvl}F-CR`, `Restrooms (${['1st', '2nd', '3rd'][lvl - 1]} floor)`, 'toilet', 45, 22, 6, 6);
    }
    addRoom(3, '3F-AUD', 'Auditorium', 'hall', 0, 18, 24, 20, { approachZ: 8 });

    const roomIdByCode = Object.fromEntries(all('SELECT id, code FROM rooms').map(r => [r.code, r.id]));
    const officeIdByName = {};
    for (const o of OFFICES) {
      const type = o.offsite ? 'offsite' : o.unconfirmed ? 'unconfirmed' : 'in_building';
      const id = run(`INSERT INTO offices(name, short_name, phone, location_type, offsite_address, has_logo, logo_file) VALUES (?,?,?,?,?,?,?)`,
        [o.name, o.short, o.phone || PHONES[o.short] || null, type, o.offsite || null, OFFICE_LOGOS[o.short] ? 1 : 0, OFFICE_LOGOS[o.short] || null]).lastId;
      officeIdByName[o.name] = id;
      if (o.room) {
        const [code, x, z, w, d] = o.room;
        const rid = addRoom(o.floor, code, o.name, 'office', x, z, w, d);
        run(`INSERT INTO office_locations(office_id, room_id, note) VALUES (?,?,?)`, [id, rid, 'Initial placement (seed).']);
      }
    }

    run(`INSERT INTO kiosks(code, name, floor_id, x, y, z, facing_deg) VALUES (?,?,?,?,?,?,?)`,
      ['KIOSK-LOBBY-1', 'Main lobby kiosk', floorIds[1], -3, 0, 6, 0]);

    // users (CHANGE THESE PASSWORDS before any real use)
    const pw = hashPassword('ChangeMe!2026');
    run(`INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)`, ['System Admin', 'admin@kiosk.local', pw, 'system_admin']);
    run(`INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)`, ['LGU Admin (MIS)', 'lgu.admin@kiosk.local', pw, 'lgu_admin']);
    run(`INSERT INTO users(name,email,password_hash,role,office_id) VALUES (?,?,?,?,?)`, ['Civil Registrar Editor', 'ccro.editor@kiosk.local', pw, 'office_editor', officeIdByName['City Civil Registrar Office']]);
    run(`INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)`, ['Report Viewer', 'viewer@kiosk.local', pw, 'viewer']);

    // services
    for (const s of charter.services) {
      const officeId = officeIdByName[s.office];
      if (!officeId) continue;
      let plain = null;
      const kws = new Set();
      for (const [re, words, p] of KEYWORDS) if (re.test(s.title)) { words.forEach(w => kws.add(w)); if (p && !plain) plain = p; }
      const sid = run(`INSERT INTO services(office_id,title,plain_title,description,office_division,classification,transaction_type,who_may_avail,total_fees,total_processing_time,period_of_extension,notes,is_citizen_facing,status,source,parse_quality)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'published', ?, ?)`,
        [officeId, s.title, plain, s.description, s.office_and_division, s.classification, s.transaction_type, s.who_may_avail,
         s.total_fees, s.total_processing_time, s.period_of_extension, s.notes || null, isG2GOnly(s.transaction_type) ? 0 : 1,
         `Citizen's Charter 2023, p. ${s.source_page}`, s.parse_quality]).lastId;
      s.requirements.forEach((r, i) => run(`INSERT INTO service_requirements(service_id,sort,requirement,where_to_secure) VALUES (?,?,?,?)`, [sid, i, r.requirement, r.where_to_secure]));
      let sort = 0;
      for (const st of s.steps) {
        const acts = st.agency_actions.length ? st.agency_actions : [{ agency_action: '', fee: '', time: '', person: '' }];
        acts.forEach((a, i) => run(`INSERT INTO service_steps(service_id,sort,client_action,agency_action,fee,processing_time,person_in_charge) VALUES (?,?,?,?,?,?,?)`,
          [sid, sort++, i === 0 ? st.client_action : '', a.agency_action, a.fee, a.time, a.person]));
      }
      for (const k of kws) run(`INSERT INTO service_keywords(service_id, keyword) VALUES (?,?)`, [sid, k]);
    }

    run(`INSERT INTO announcements(title, body, tone) VALUES (?,?,?)`,
      ['Office hours', 'City Hall offices are open Monday to Friday, 8:00 AM – 5:00 PM, except holidays.', 'info']);
  });
  saveNow();
  const counts = get(`SELECT (SELECT count(*) FROM offices) offices, (SELECT count(*) FROM rooms) rooms,
    (SELECT count(*) FROM services) services, (SELECT count(*) FROM services WHERE is_citizen_facing=1) citizen_facing,
    (SELECT count(*) FROM service_steps) steps, (SELECT count(*) FROM service_requirements) requirements`);
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__dirname, 'seed.js')) {
  seed({ reset: true }).then(c => {
    console.log('Seeded database:', c);
    console.log('Admin sign-in: admin@kiosk.local / ChangeMe!2026  (change it in Admin > Users)');
  });
}
