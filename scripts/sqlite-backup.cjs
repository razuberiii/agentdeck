#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const [source, destination] = process.argv.slice(2);
const stallMs = Number(process.env.SQLITE_BACKUP_STALL_MS || 30_000);
const overallMs = Number(process.env.SQLITE_BACKUP_OVERALL_MS || 300_000);
if (!source || !destination || !Number.isFinite(stallMs) || !Number.isFinite(overallMs)) {
  console.error('usage: sqlite-backup.cjs SOURCE DESTINATION');
  process.exit(2);
}

const partial = `${destination}.partial.${process.pid}`;
let db;
let lastProgress = Date.now();
let started = Date.now();
let progress = { totalPages: 0, remainingPages: 0 };
const cleanup = () => { try { fs.rmSync(partial, { force: true }); } catch {} };
const fail = error => {
  cleanup();
  try { db?.close(); } catch {}
  console.error(`sqlite backup failed: ${error?.message || error}`);
  process.exit(1);
};

try {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  cleanup();
  db = new Database(source, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 1000');
  const sourceBytes = fs.statSync(source).size;
  const walBytes = (() => { try { return fs.statSync(`${source}-wal`).size; } catch { return 0; } })();
  const timer = setInterval(() => {
    const now = Date.now();
    const copied = Math.max(0, progress.totalPages - progress.remainingPages);
    const percent = progress.totalPages ? ((copied / progress.totalPages) * 100).toFixed(1) : '0.0';
    console.error(`sqlite backup progress elapsedMs=${now-started} totalPages=${progress.totalPages} remainingPages=${progress.remainingPages} copiedPages=${copied} percent=${percent} sourceBytes=${sourceBytes} walBytes=${walBytes} lastProgressMs=${now-lastProgress}`);
    if (now - started > overallMs) fail(new Error(`overall timeout after ${overallMs}ms`));
    if (now - lastProgress > stallMs) fail(new Error(`stalled for ${stallMs}ms`));
  }, 5_000);
  timer.unref();
  db.backup(partial, { progress(info) { progress = info; lastProgress = Date.now(); return 100; } }).then(() => {
    clearInterval(timer);
    db.close(); db = undefined;
    const check = new Database(partial, { readonly: true, fileMustExist: true });
    const result = check.pragma('quick_check', { simple: true });
    check.close();
    if (result !== 'ok') throw new Error(`quick_check returned ${String(result)}`);
    fs.renameSync(partial, destination);
    console.error(`sqlite backup complete elapsedMs=${Date.now()-started} destinationBytes=${fs.statSync(destination).size}`);
  }).catch(fail);
} catch (error) { fail(error); }
