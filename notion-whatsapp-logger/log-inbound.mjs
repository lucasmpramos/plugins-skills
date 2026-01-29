#!/usr/bin/env node
// Append an inbound WhatsApp message to:
// 1) Notion WhatsApp Logs (Daily) page body (one page per contact per day)
// 2) local markdown log under /home/ubuntu/clawd/whatsapp_logs/
// Notion-Version: 2025-09-03
//
// Call this BEFORE processing/responding to preserve correct chronological order.
// (Outbound uses log-outbound.mjs which is called at send time.)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NOTION_VERSION = '2025-09-03';
const TZ = 'America/Sao_Paulo';

// Convert to São Paulo local time ISO string
function toSpIso(date = new Date()) {
  return date.toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');
}
const STATE_FILE = path.join(process.env.HOME || '/home/ubuntu', '.clawdbot/logs-daily-state.json');

function readKey() {
  const p = path.join(process.env.HOME || '/home/ubuntu', '.config/notion/api_key');
  return fs.readFileSync(p, 'utf8').trim();
}

async function notion(method, urlPath, body) {
  const key = readKey();
  const res = await fetch(`https://api.notion.com/v1${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.message || json?.raw || `HTTP ${res.status}`);
  return json;
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

// Convert any ISO/timestamp to São Paulo date (YYYY-MM-DD) and time (HH:MM:SS)
function dateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10); // fallback
  // Get São Paulo date
  return d.toLocaleDateString('sv-SE', { timeZone: TZ }); // sv-SE gives YYYY-MM-DD
}
function timeKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(11, 19); // fallback
  // Get São Paulo time
  return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }); // HH:MM:SS
}

function sanitizeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_+.-]/g, '')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'unknown';
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// Load state to check for duplicates
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { seen: {} };
}

function saveState(st) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Prune old entries
  const keys = Object.keys(st.seen || {});
  if (keys.length > 5000) {
    const keep = keys.slice(-2000);
    const next = {};
    for (const k of keep) next[k] = 1;
    st.seen = next;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

function appendMd(outdir, contactName, phone, iso, text, mediaType, mediaPath) {
  const folder = `${sanitizeSlug(contactName || 'contact')}_${sanitizeSlug(phone || 'unknown')}`;
  const day = dateKey(iso);
  const outDir = path.join(outdir, folder);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${day}.md`);

  const t = timeKey(iso);
  const name = contactName || phone || 'Contact';
  const emoji = '👤';
  const msg = String(text || '').trim();
  const media = mediaType ? `\n(media:${mediaType})` : '';
  const pathPart = mediaPath ? `\n${mediaPath}` : '';

  // Discord-style block (readable in .md and Notion):
  // 👤 Contact [HH:MM:SS]
  // message...
  const block = `${emoji} ${name} [${t}]\n${msg}${media}${pathPart}\n\n`;
  fs.appendFileSync(filePath, block.slice(0, 20000));
}

async function findContactByPhone(contactsDs, phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  const tries = [raw, digits, digits.replace(/^55/, '')].filter(Boolean);

  for (const needle of tries) {
    try {
      const q = await notion('POST', `/data_sources/${contactsDs}/query`, {
        filter: { property: 'Phone', phone_number: { contains: needle } },
        page_size: 1
      });
      const p = (q.results || [])[0];
      if (!p) continue;
      const title = p?.properties?.Name?.title;
      const name = Array.isArray(title) ? title.map(x => x.plain_text || '').join('') : null;
      return { pageId: p.id, name: name || null };
    } catch {
      // ignore and try next
    }
  }

  return null;
}

async function getOrCreateDailyPage(logsDs, day, contactPageId, contactName, phone) {
  const filter = {
    and: [
      { property: 'Day', date: { equals: day } },
      contactPageId
        ? { property: 'Contact', relation: { contains: contactPageId } }
        : { property: 'Phone', rich_text: { equals: String(phone || '') } }
    ]
  };

  const existing = await notion('POST', `/data_sources/${logsDs}/query`, { filter, page_size: 1 });
  const found = (existing.results || [])[0];
  if (found) return found.id;

  const title = `${day} — ${contactName || phone || 'Unknown'}`.slice(0, 180);
  const props = {
    Name: { title: [{ type: 'text', text: { content: title } }] },
    Day: { date: { start: day } },
    Channel: { select: { name: 'WhatsApp' } },
    Phone: phone ? { rich_text: [{ type: 'text', text: { content: String(phone).slice(0, 1900) } }] } : { rich_text: [] }
  };
  if (contactPageId) props.Contact = { relation: [{ id: contactPageId }] };

  const page = await notion('POST', '/pages', {
    parent: { data_source_id: logsDs },
    properties: props
  });
  return page.id;
}

async function appendNotion(pageId, iso, contactName, phone, text, mediaType, mediaPath) {
  const t = timeKey(iso);
  const name = contactName || phone || 'Contact';
  const emoji = '👤';
  const msg = String(text || '').trim().slice(0, 1600);
  const media = mediaType ? `\n(media:${mediaType})` : '';
  const pathPart = mediaPath ? `\n${mediaPath}` : '';

  await notion('PATCH', `/blocks/${pageId}/children`, {
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: `${emoji} ${name} [${t}]\n` }, annotations: { bold: true } },
            { type: 'text', text: { content: `${msg}${media}${pathPart}` } }
          ]
        }
      }
    ]
  });
}

async function main() {
  const logsDs = arg('--logsDs');
  const contactsDs = arg('--contactsDs');
  const from = arg('--from');
  const text = arg('--text') || '';
  const iso = arg('--time') || toSpIso();
  const outdir = arg('--outdir') || '/home/ubuntu/clawd/whatsapp_logs';
  const mediaType = arg('--mediaType');
  const mediaPath = arg('--mediaPath');

  if (!logsDs || !contactsDs || !from) {
    console.error('Usage: node log-inbound.mjs --logsDs <id> --contactsDs <id> --from <+number> --text <message> [--time <iso>] [--outdir <dir>] [--mediaType <type>] [--mediaPath <path>]');
    process.exit(2);
  }

  // Check for duplicates (same message logged twice)
  const st = loadState();
  const key = sha1(`in|${from}|${iso}|${text}|${mediaPath || ''}`);
  if (st.seen?.[key]) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'duplicate' }, null, 2));
    return;
  }

  const contact = await findContactByPhone(contactsDs, from).catch(() => null);
  const contactName = contact?.name || from;

  appendMd(outdir, contactName, from, iso, text, mediaType, mediaPath);

  const pageId = await getOrCreateDailyPage(logsDs, dateKey(iso), contact?.pageId || null, contactName, from);
  await appendNotion(pageId, iso, contactName, from, text, mediaType, mediaPath);

  // Mark as seen
  st.seen[key] = 1;
  saveState(st);

  console.log(JSON.stringify({ ok: true, from, contactName, pageId }, null, 2));
}

main().catch(err => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
