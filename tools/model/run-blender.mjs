#!/usr/bin/env node
// Guarded background Blender launcher for the model tools.
//
//   node tools/model/run-blender.mjs <script.py> [--wait-min N] [--] [script args...]
//
// Same memory rules as the model workspace's run_front_blender.py, because this machine has ~8 GB:
//   - start only when at least 2.35 GiB of physical memory is available (waits up to --wait-min minutes),
//   - stop Blender if availability drops under 1 GiB while it runs,
//   - one Blender at a time (lock file), one render thread, below-normal priority.
// It never touches other processes. Exit codes: Blender's own, 3 = stopped under 1 GiB, 4 = memory never
// became available, 5 = another guarded Blender is running.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLENDER = process.env.BLENDER_EXE || 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const START_GIB = Number(process.env.BLENDER_START_GIB || 2.35);
const STOP_GIB = 1.0;
const LOG_DIR = path.join(HERE, '.logs');
const LOCK = path.join(LOG_DIR, 'blender.lock');

const args = process.argv.slice(2);
const script = args.shift();
if (!script) { console.error('usage: run-blender.mjs <script.py> [--wait-min N] [--] [args...]'); process.exit(2); }
let waitMin = 0;
if (args[0] === '--wait-min') { args.shift(); waitMin = Number(args.shift()); }
if (args[0] === '--') args.shift();

const availGiB = () => os.freemem() / 2 ** 30; // on Windows: available physical memory
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(LOG_DIR, { recursive: true });

if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
  if (alive) { console.log(JSON.stringify({ status: 'another_blender_running', pid })); process.exit(5); }
}

const deadline = Date.now() + waitMin * 60_000;
let start = availGiB();
while (start < START_GIB) {
  if (Date.now() >= deadline) {
    console.log(JSON.stringify({ status: 'waiting_for_memory', available_GiB: +start.toFixed(2), required_GiB: START_GIB }));
    process.exit(4);
  }
  await sleep(15_000); start = availGiB();
}

const stem = path.basename(script, '.py');
const log = path.join(LOG_DIR, `${stem}.log`);
const out = fs.openSync(log, 'w');
const child = spawn(BLENDER, ['--background', '--factory-startup', '--threads', '1', '--python-exit-code', '1',
  '--python', path.resolve(script), '--', ...args], { stdio: ['ignore', out, out], windowsHide: true });
fs.writeFileSync(LOCK, String(child.pid));
try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }

let min = start, stopped = false;
const timer = setInterval(() => {
  const a = availGiB(); min = Math.min(min, a);
  if (a < STOP_GIB && !stopped) { stopped = true; child.kill(); }
}, 1000);
const code = await new Promise(r => child.on('exit', c => r(c ?? 1)));
clearInterval(timer);
fs.rmSync(LOCK, { force: true });
const result = { status: stopped ? 'stopped_under_1GiB' : code === 0 ? 'ok' : 'failed', exit_code: code,
  start_available_GiB: +start.toFixed(2), minimum_available_GiB: +min.toFixed(2), log };
console.log(JSON.stringify(result));
console.log(fs.readFileSync(log, 'utf8').slice(-3000));
process.exit(stopped ? 3 : code);
