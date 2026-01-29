#!/usr/bin/env node
// Create a "WhatsApp Logs (Daily)" database under a parent Notion page.
// One page per contact per day; message transcript is appended to page body.
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

const parentPageId = arg('--parent');
const contactsDbId = arg('--contacts-db');
if (!parentPageId || !contactsDbId) {
  console.error('Usage: node create-db.mjs --parent <page_id> --contacts-db <contacts_database_id>');
  process.exit(1);
}

const title = 'WhatsApp Logs (Daily)';

const db = await notion('POST', '/databases', {
  parent: { type: 'page_id', page_id: parentPageId },
  title: [{ type: 'text', text: { content: title } }],
  properties: {
    Name: { title: {} },
    Day: { date: {} },
    Contact: { relation: { database_id: contactsDbId, single_property: {} } },
    Phone: { rich_text: {} },
    Channel: { select: { options: [{ name: 'WhatsApp' }] } }
  }
});

console.log(JSON.stringify({
  databaseId: db.id,
  dataSourceId: db.data_sources?.[0]?.id || null,
  url: db.url,
  title
}, null, 2));
