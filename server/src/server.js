import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb, DB_FILE, ROOT } from './db.js';
import { seed } from './seed.js';
import { publicApi } from './routes/public.js';
import { authApi, adminApi } from './routes/admin.js';

const PORT = Number(process.env.PORT || 3000);

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}
// QR codes must point to an address a PHONE can reach, not "localhost".
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://${lanAddress()}:${PORT}`;

export async function createApp() {
  if (!fs.existsSync(DB_FILE)) {
    console.log('No database yet — creating and seeding from the 2023 Citizen\'s Charter…');
    await seed({ reset: true });
  } else {
    await openDb();
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { // basic security headers
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/config', (req, res) => res.json({ public_base_url: PUBLIC_BASE_URL }));
  app.use('/api/auth', authApi);
  app.use('/api/admin', adminApi);
  app.use('/api', publicApi);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

  const pub = path.join(ROOT, 'public');
  app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three')));
  app.use(express.static(pub, { extensions: ['html'] }));
  // single-page apps
  app.get(['/kiosk', '/kiosk/*'], (req, res) => res.sendFile(path.join(pub, 'kiosk', 'index.html')));
  app.get(['/admin', '/admin/*'], (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
  app.get(['/m', '/m/*'], (req, res) => res.sendFile(path.join(pub, 'm', 'index.html')));
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'server.js'))) {
  const app = await createApp();
  app.listen(PORT, () => {
    console.log(`\nMalaybalay City Hall Kiosk prototype is running:\n`);
    console.log(`  Kiosk        http://localhost:${PORT}/kiosk`);
    console.log(`  Admin panel  http://localhost:${PORT}/admin   (admin@kiosk.local / ChangeMe!2026)`);
    console.log(`  Phone page   ${PUBLIC_BASE_URL}/m   (open from a phone on the same Wi-Fi)`);
    console.log(`  API          http://localhost:${PORT}/api/health\n`);
  });
}
