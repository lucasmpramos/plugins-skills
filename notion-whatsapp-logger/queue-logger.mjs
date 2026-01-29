#!/usr/bin/env node
/**
 * WhatsApp Log Queue Logger
 * 
 * Appends a message event to the local JSONL queue file.
 * The queue is processed by a separate worker that guarantees ordering.
 * 
 * Usage:
 *   node queue-logger.mjs --direction in|out --phone <phone> --text <text> [--time <ISO>]
 */

import fs from 'node:fs';
import path from 'node:path';

const QUEUE_FILE = '/tmp/whatsapp-log-queue.jsonl';

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      result[args[i].slice(2)] = args[++i];
    }
  }
  return result;
}

const args = parseArgs();

if (!args.direction || !args.phone || !args.text) {
  console.error('Usage: node queue-logger.mjs --direction in|out --phone <phone> --text <text> [--time <ISO>]');
  process.exit(1);
}

const event = {
  ts: args.time || new Date().toISOString(),
  direction: args.direction, // 'in' or 'out'
  phone: args.phone,
  text: args.text,
  logged: false,
};

// Append to queue file (atomic via rename not needed - just append)
fs.appendFileSync(QUEUE_FILE, JSON.stringify(event) + '\n');
console.log(JSON.stringify({ ok: true, queued: event.ts }));
