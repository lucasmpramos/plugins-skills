#!/usr/bin/env node
// Rebuild WhatsApp logs in correct chronological order
// Clears existing entries and re-creates them sorted by timestamp

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const NOTION_VERSION = '2025-09-03';
const SESSION_DIR = path.join(process.env.HOME, '.clawdbot/agents/main/sessions');
const TZ = 'America/Sao_Paulo';

function readKey() {
  return fs.readFileSync(path.join(process.env.HOME, '.config/notion/api_key'), 'utf8').trim();
}

async function notion(method, url, body) {
  const res = await fetch(`https://api.notion.com/v1${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${readKey()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
  return json;
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function toLocalTime(isoUtc) {
  const d = new Date(isoUtc);
  return d.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');
}

function dateKey(localIso) { return localIso.slice(0, 10); }
function timeKey(localIso) { return localIso.slice(11, 19); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_+.-]/g, '_').slice(0, 80) || 'x'; }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i++; }
  }
  return out;
}

// Find transcript for audio
function findTranscript(isoTime, phone) {
  try {
    const digits = String(phone).replace(/\D/g, '');
    const targetMs = new Date(isoTime).getTime();
    
    const cmd = `grep -h '"role":"user"' ${SESSION_DIR}/*.jsonl 2>/dev/null | grep "Transcript:" | grep "${digits}"`;
    let output;
    try { output = execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return null; }
    
    for (const line of output.split('\n').filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        const msgMs = new Date(obj.timestamp).getTime();
        if (Math.abs(msgMs - targetMs) > 2 * 60 * 1000) continue;
        
        const text = obj.message?.content?.[0]?.text || '';
        if (!text.includes('[Audio]') || !text.includes('Transcript:')) continue;
        
        const match = text.match(/Transcript:\n([\s\S]*?)\n\[message_id:/);
        if (match?.[1]?.trim()) return match[1].trim();
      } catch {}
    }
  } catch {}
  return null;
}

// Find contact
async function findContact(contactsDs, phone) {
  const digits = String(phone).replace(/\D/g, '');
  for (const needle of [digits, digits.replace(/^55/, ''), digits.slice(-10)]) {
    try {
      const q = await notion('POST', `/data_sources/${contactsDs}/query`, {
        filter: { property: 'Phone', phone_number: { contains: needle } },
        page_size: 1
      });
      if (q.results?.[0]) {
        const name = q.results[0].properties?.Name?.title?.map(t => t.plain_text).join('');
        return { pageId: q.results[0].id, name };
      }
    } catch {}
  }
  return null;
}

// Get or create daily page
async function getOrCreatePage(logsDs, day, contactId, contactName, phone) {
  const filter = {
    and: [
      { property: 'Day', date: { equals: day } },
      contactId
        ? { property: 'Contact', relation: { contains: contactId } }
        : { property: 'Phone', rich_text: { equals: phone } }
    ]
  };
  
  const existing = await notion('POST', `/data_sources/${logsDs}/query`, { filter, page_size: 1 });
  if (existing.results?.[0]) return existing.results[0].id;
  
  const props = {
    Name: { title: [{ text: { content: `${day} — ${contactName || phone}`.slice(0, 180) } }] },
    Day: { date: { start: day } },
    Channel: { select: { name: 'WhatsApp' } },
    Phone: { rich_text: [{ text: { content: String(phone).slice(0, 1900) } }] }
  };
  if (contactId) props.Contact = { relation: [{ id: contactId }] };
  
  const page = await notion('POST', '/pages', { parent: { data_source_id: logsDs }, properties: props });
  return page.id;
}

// Clear all blocks from a page
async function clearPageBlocks(pageId) {
  const blocks = await notion('GET', `/blocks/${pageId}/children?page_size=100`);
  for (const block of blocks.results || []) {
    try {
      await notion('DELETE', `/blocks/${block.id}`);
    } catch {}
  }
}

// Append to Notion
async function appendNotion(pageId, localIso, label, text) {
  await notion('PATCH', `/blocks/${pageId}/children`, {
    children: [{
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [
          { text: { content: `${label} [${timeKey(localIso)}]\n` }, annotations: { bold: true } },
          { text: { content: String(text).slice(0, 1800) } }
        ]
      }
    }]
  });
}

// --- Main ---
const { logsDs, contactsDs, phone, day, outdir = '/home/ubuntu/clawd/whatsapp_logs' } = parseArgs();

if (!logsDs || !contactsDs || !phone || !day) {
  console.error('Usage: node rebuild-logs.mjs --logsDs <id> --contactsDs <id> --phone <+number> --day <YYYY-MM-DD>');
  process.exit(1);
}

const logFile = `/tmp/clawdbot/clawdbot-${day}.log`;
if (!fs.existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

console.log(`Rebuilding logs for ${phone} on ${day}...`);

// Collect all messages for this phone
const content = fs.readFileSync(logFile, 'utf8');
const lines = content.split('\n').filter(Boolean);

const messages = [];
const seen = new Set();

for (const line of lines) {
  if (!line.includes('web-inbound')) continue;
  
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (!obj._meta?.date || !String(obj[0]).includes('web-inbound')) continue;
  
  const payload = obj[1] || {};
  if (payload.from !== phone) continue;
  
  const isoUtc = obj._meta.date;
  const localIso = toLocalTime(isoUtc);
  if (!localIso.startsWith(day)) continue; // Only messages from this day (local time)
  
  const mediaType = payload.mediaType || '';
  let text = payload.body || '';
  
  // Handle audio
  if (mediaType.includes('audio')) {
    const transcript = findTranscript(isoUtc, phone);
    if (transcript) {
      text = `🎤 ${transcript}`;
    } else {
      text = `🎤 [audio sem transcript]`;
    }
  }
  
  // Dedupe
  const key = sha1(`${phone}|${isoUtc}|${text}`);
  if (seen.has(key)) continue;
  seen.add(key);
  
  messages.push({ isoUtc, localIso, text });
}

// Sort by UTC timestamp
messages.sort((a, b) => new Date(a.isoUtc) - new Date(b.isoUtc));

console.log(`Found ${messages.length} messages`);

// Get contact info
const contact = await findContact(contactsDs, phone);
const name = contact?.name || phone;
const label = `👤 ${name}`;

// Clear and rebuild MD file
const mdDir = path.join(outdir, `${slug(name)}_${slug(phone)}`);
fs.mkdirSync(mdDir, { recursive: true });
const mdFile = path.join(mdDir, `${day}.md`);
fs.writeFileSync(mdFile, ''); // Clear

// Get/create Notion page and clear it
const pageId = await getOrCreatePage(logsDs, day, contact?.pageId, name, phone);
console.log(`Clearing Notion page ${pageId}...`);
await clearPageBlocks(pageId);

// Write all messages in order
console.log(`Writing ${messages.length} messages...`);
for (const msg of messages) {
  // MD
  fs.appendFileSync(mdFile, `${label} [${timeKey(msg.localIso)}]\n${msg.text}\n\n`);
  
  // Notion
  await appendNotion(pageId, msg.localIso, label, msg.text);
}

// Update state to current file position
const stateFile = path.join(path.dirname(import.meta.url.replace('file://', '')), 'state.json');
const stat = fs.statSync(logFile);
const state = { pos: stat.size, seen: {} };
// Add all processed messages to seen
for (const msg of messages) {
  const key = sha1(`${phone}|${msg.isoUtc}|${msg.text}`);
  state.seen[key] = 1;
}
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

console.log(`Done! ${messages.length} messages rebuilt in correct order.`);
console.log(`MD: ${mdFile}`);
console.log(`Notion page: ${pageId}`);
