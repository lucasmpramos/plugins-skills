#!/usr/bin/env node
// WhatsApp conversation logger - logs IN messages to Notion + MD
// Audio transcripts are found in session files by matching timestamps

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const NOTION_VERSION = '2025-09-03';
const SESSION_DIR = path.join(process.env.HOME, '.clawdbot/agents/main/sessions');

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

const TZ = 'America/Sao_Paulo';

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function toLocalTime(isoUtc) {
  return new Date(isoUtc).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');
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

// Find transcript for audio message by matching phone + timestamp within 2 min window
function findTranscript(isoTime, phone) {
  try {
    const digits = String(phone).replace(/\D/g, '');
    const targetMs = new Date(isoTime).getTime();
    
    // Search session files for audio messages with transcripts for this phone
    // Pattern: role":"user" ... contains [Audio] and Transcript: and the phone number
    const cmd = `grep -h '"role":"user"' ${SESSION_DIR}/*.jsonl 2>/dev/null | grep "Transcript:" | grep "${digits}"`;
    
    let output;
    try {
      output = execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    } catch {
      return null;
    }
    
    for (const line of output.split('\n').filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        const msgMs = new Date(obj.timestamp).getTime();
        const diffMs = Math.abs(msgMs - targetMs);
        
        // Must be within 2 minutes
        if (diffMs > 2 * 60 * 1000) continue;
        
        const text = obj.message?.content?.[0]?.text || '';
        if (!text.includes('[Audio]') || !text.includes('Transcript:')) continue;
        
        // Extract transcript between "Transcript:\n" and "\n[message_id:"
        const match = text.match(/Transcript:\n([\s\S]*?)\n\[message_id:/);
        if (match?.[1]?.trim()) {
          return match[1].trim();
        }
      } catch {}
    }
  } catch {}
  return null;
}

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

function appendMd(outdir, name, phone, iso, label, text) {
  const dir = path.join(outdir, `${slug(name)}_${slug(phone)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${dateKey(iso)}.md`), `${label} [${timeKey(iso)}]\n${text}\n\n`);
}

async function appendNotion(pageId, iso, label, text) {
  await notion('PATCH', `/blocks/${pageId}/children`, {
    children: [{
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [
          { text: { content: `${label} [${timeKey(iso)}]\n` }, annotations: { bold: true } },
          { text: { content: String(text).slice(0, 1800) } }
        ]
      }
    }]
  });
}

// --- Main ---
const { logsDs, contactsDs, state, outdir = '/home/ubuntu/clawd/whatsapp_logs' } = parseArgs();
// Use São Paulo date for log file (matches user's timezone)
const spDate = new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10);
const logFile = `/tmp/clawdbot/clawdbot-${spDate}.log`;

if (!logsDs || !contactsDs || !state) {
  console.error('Usage: node poll.mjs --logsDs <id> --contactsDs <id> --state <file>');
  process.exit(1);
}

let st = { pos: 0, seen: {} };
try { st = JSON.parse(fs.readFileSync(state, 'utf8')); } catch {}

const stat = fs.statSync(logFile);
if (st.pos > stat.size) st.pos = 0;

const content = fs.readFileSync(logFile, 'utf8').slice(st.pos);
const lines = content.split('\n').filter(Boolean);

let newCount = 0;

for (const line of lines) {
  if (!line.includes('web-inbound')) continue;
  
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (!obj._meta?.date || !String(obj[0]).includes('web-inbound')) continue;
  
  const { from, body, mediaType } = obj[1] || {};
  const isoUtc = obj._meta.date;
  const localIso = toLocalTime(isoUtc);
  
  // Handle audio - find transcript
  const isAudio = mediaType?.includes('audio');
  let text = body || '';
  
  if (isAudio) {
    const transcript = findTranscript(isoUtc, from);
    if (transcript) {
      text = `🎤 ${transcript}`;
    } else {
      // No transcript yet - skip, retry next poll
      continue;
    }
  }
  
  // Dedupe
  const key = sha1(`${from}|${isoUtc}|${text}`);
  if (st.seen[key]) continue;
  
  // Log
  const contact = await findContact(contactsDs, from);
  const name = contact?.name || from;
  const label = `👤 ${name}`;
  
  appendMd(outdir, name, from, localIso, label, text);
  
  const pageId = await getOrCreatePage(logsDs, dateKey(localIso), contact?.pageId, name, from);
  await appendNotion(pageId, localIso, label, text);
  
  st.seen[key] = 1;
  newCount++;
}

st.pos = stat.size;

// Prune old seen
const keys = Object.keys(st.seen);
if (keys.length > 10000) st.seen = Object.fromEntries(keys.slice(-5000).map(k => [k, 1]));

fs.writeFileSync(state, JSON.stringify(st, null, 2));
console.log(JSON.stringify({ changed: newCount > 0, newCount }));
