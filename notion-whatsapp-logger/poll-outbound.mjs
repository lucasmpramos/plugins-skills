#!/usr/bin/env node
// Poll gateway log for outbound WhatsApp messages

import fs from 'node:fs';
import crypto from 'node:crypto';

const QUEUE_FILE = '/tmp/whatsapp-log-queue.jsonl';
const STATE_FILE = '/home/ubuntu/clawd/workflows/whatsapp/logs-daily/outbound-state.json';

function getLogPath() {
  return `/tmp/clawdbot/clawdbot-${new Date().toISOString().slice(0, 10)}.log`;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { pos: 0, seen: {} }; }
}

function saveState(st) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

function queueEvent(event) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify({ ...event, logged: false }) + '\n');
}

async function main() {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return;

  const st = loadState();
  if (typeof st.pos !== 'number') st.pos = 0;
  if (!st.seen) st.seen = {};
  
  const stat = fs.statSync(logPath);
  let start = st.pos > stat.size ? 0 : st.pos;

  const lines = fs.readFileSync(logPath, 'utf8').slice(start).split('\n').filter(Boolean);
  let newCount = 0;

  for (const line of lines) {
    if (!line.includes('auto-reply sent')) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const p = obj["1"];
    if (!p?.to || !p?.text) continue;

    const text = p.text.replace(/ … \(truncated \d+ chars\)$/, '');
    const iso = obj._meta?.date || new Date().toISOString();
    const hash = crypto.createHash('sha1').update(`out|${p.to}|${iso}|${text}`).digest('hex');
    
    if (st.seen[hash]) continue;
    queueEvent({ direction: 'out', phone: p.to.replace(/[^\d+]/g, ''), text, ts: iso });
    st.seen[hash] = 1;
    newCount++;
  }

  st.pos = stat.size;
  const keys = Object.keys(st.seen);
  if (keys.length > 1000) for (const k of keys.slice(0, keys.length - 1000)) delete st.seen[k];
  saveState(st);
  console.log(`Processed ${newCount} outbound`);
}

main().catch(console.error);
