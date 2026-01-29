#!/usr/bin/env node
// Append an outbound WhatsApp message to:
// 1) Notion WhatsApp Logs (Daily) page body (one page per contact per day)
// 2) local markdown log under /home/ubuntu/clawd/whatsapp_logs/
// Notion-Version: 2025-09-03

import fs from 'node:fs';
import path from 'node:path';

const NOTION_VERSION = '2025-09-03';

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

const TZ = 'America/Sao_Paulo';

function toLocalTime(isoUtc) {
  return new Date(isoUtc).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');
}
function dateKey(localIso) {
  return localIso.slice(0, 10);
}
function timeKey(localIso) {
  return localIso.slice(11, 19);
}

function sanitizeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_+.-]/g, '')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'unknown';
}

function appendMd(outdir, contactName, phone, iso, text) {
  const folder = `${sanitizeSlug(contactName || 'contact')}_${sanitizeSlug(phone || 'unknown')}`;
  const day = dateKey(iso);
  const outDir = path.join(outdir, folder);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${day}.md`);

  const t = timeKey(iso);
  const name = 'Bob';
  const emoji = '🦞';
  const msg = String(text || '').trim();

  // Discord-style block (readable in .md and Notion):
  // 🦞 Bob [HH:MM:SS]
  // message...
  const block = `${emoji} ${name} [${t}]\n${msg}\n\n`;
  fs.appendFileSync(filePath, block.slice(0, 20000));
}

async function findContactByPhone(contactsDs, phone) {
  // Contacts DB uses `Phone` as `phone_number`.
  // Notion formats phone numbers (spaces/dashes). We match by multiple substrings.
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');

  function fmtLocalDash(local) {
    if (!local || local.length < 8) return null;
    return `${local.slice(0, -4)}-${local.slice(-4)}`;
  }

  function fmtBR(d) {
    // E.164 digits: 55 + DDD(2) + local
    if (!d || !d.startsWith('55') || d.length < 12) return [];
    const ddd = d.slice(2, 4);
    const local = d.slice(4);
    const dash = fmtLocalDash(local);
    return [
      dash ? `${ddd} ${dash}` : null,
      dash,
      `${ddd}${local}`,
      local,
      local.length >= 10 ? local.slice(-10) : null
    ].filter(Boolean);
  }

  function fmtUS(d) {
    // 1 + NPA(3) + NXX(3) + XXXX(4)
    const dd = d.startsWith('1') && d.length === 11 ? d : null;
    if (!dd) return [];
    const area = dd.slice(1, 4);
    const mid = dd.slice(4, 7);
    const last = dd.slice(7);
    return [
      `${area}-${mid}-${last}`,
      `${area} ${mid}-${last}`,
      `${mid}-${last}`,
      dd.slice(1),
      dd.slice(-10)
    ].filter(Boolean);
  }

  const tries = [
    raw,
    digits,
    digits.replace(/^55/, ''),
    digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : null,
    digits.length >= 10 ? digits.slice(-10) : null,
    ...fmtBR(digits),
    ...fmtUS(digits)
  ].filter(Boolean);

  for (const needle of tries) {
    const q = await notion('POST', `/data_sources/${contactsDs}/query`, {
      filter: { property: 'Phone', phone_number: { contains: needle } },
      page_size: 1
    });
    const p = (q.results || [])[0];
    if (!p) continue;
    const title = p?.properties?.Name?.title;
    const name = Array.isArray(title) ? title.map(x => x.plain_text || '').join('') : null;
    return { pageId: p.id, name: name || null };
  }

  return null;
}

function contactsDbIdFromState() {
  try {
    const p = '/home/ubuntu/clawd/workflows/notion/STATE.json';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j?.contacts?.databaseId || null;
  } catch {
    return null;
  }
}

async function upsertContact(contactsDs, phone, fallbackName) {
  // contactsDs is the Contacts *data_source_id*.
  const raw = String(phone || '').trim();
  if (!raw) return null;

  const found = await findContactByPhone(contactsDs, raw).catch(() => null);
  if (found) return found;

  const contactsDbId = contactsDbIdFromState();
  if (!contactsDbId) return null;

  // Create minimal contact if missing.
  const name = String(fallbackName || raw).slice(0, 120);
  const page = await notion('POST', '/pages', {
    parent: { database_id: contactsDbId },
    properties: {
      Name: { title: [{ type: 'text', text: { content: name } }] },
      Phone: { phone_number: raw }
    }
  });

  return { pageId: page.id, name };
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

async function appendNotion(pageId, iso, contactName, phone, text) {
  const t = timeKey(iso);
  const name = 'Bob';
  const emoji = '🦞';
  const msg = String(text || '').trim().slice(0, 1600);

  // Notion block: paragraph with header + newline + body
  await notion('PATCH', `/blocks/${pageId}/children`, {
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: `${emoji} ${name} [${t}]\n` }, annotations: { bold: true } },
            { type: 'text', text: { content: msg } }
          ]
        }
      }
    ]
  });
}

async function main() {
  const logsDs = arg('--logsDs');
  const contactsDs = arg('--contactsDs');
  const to = arg('--to');
  const text = arg('--text') || '';
  const isoUtc = arg('--time') || new Date().toISOString();
  const localIso = toLocalTime(isoUtc);
  const outdir = arg('--outdir') || '/home/ubuntu/clawd/whatsapp_logs';

  if (!logsDs || !contactsDs || !to) {
    console.error('Usage: node log-outbound.mjs --logsDs <id> --contactsDs <id> --to <+number> --text <message> [--time <iso>] [--outdir <dir>]');
    process.exit(2);
  }

  // Ensure the contact exists so daily logs can always relate to a Contacts row.
  const contact = await upsertContact(contactsDs, to, null).catch(() => null);
  const contactName = contact?.name || to;

  appendMd(outdir, contactName, to, localIso, text);

  const pageId = await getOrCreateDailyPage(logsDs, dateKey(localIso), contact?.pageId || null, contactName, to);
  await appendNotion(pageId, localIso, contactName, to, text);

  console.log(JSON.stringify({ ok: true, to, pageId }, null, 2));
}

main().catch(err => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
