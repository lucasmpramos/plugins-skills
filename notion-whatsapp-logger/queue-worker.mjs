#!/usr/bin/env node
/**
 * WhatsApp Log Queue Worker
 * 
 * Reads the JSONL queue file, sorts events by timestamp, and writes them
 * to Notion in order. Guarantees correct ordering by processing serially.
 * 
 * Usage:
 *   node queue-worker.mjs --logsDs <id> --contactsDs <id>
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const QUEUE_FILE = '/tmp/whatsapp-log-queue.jsonl';
const LOCK_FILE = '/tmp/whatsapp-log-queue.lock';
const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);

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

if (!args.logsDs || !args.contactsDs) {
  console.error('Usage: node queue-worker.mjs --logsDs <id> --contactsDs <id>');
  process.exit(1);
}

// Simple file-based lock to prevent concurrent runs
function acquireLock() {
  try {
    // Check if lock file exists and is recent (< 5 min)
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 5 * 60 * 1000) {
        console.log('Another worker is running (lock held). Exiting.');
        process.exit(0);
      }
      // Stale lock, remove it
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (err) {
    console.error('Failed to acquire lock:', err.message);
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {}
}

function runScript(scriptName, scriptArgs) {
  return new Promise((resolve, reject) => {
    const cp = spawn('node', [path.join(SCRIPTS_DIR, scriptName), ...scriptArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '', stderr = '';
    cp.stdout.on('data', d => stdout += String(d));
    cp.stderr.on('data', d => stderr += String(d));
    cp.on('error', reject);
    cp.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Script ${scriptName} failed (code ${code}): ${stderr}`));
      }
    });
  });
}

async function processQueue() {
  if (!acquireLock()) {
    return;
  }

  try {
    if (!fs.existsSync(QUEUE_FILE)) {
      console.log('No queue file. Nothing to process.');
      return;
    }

    const content = fs.readFileSync(QUEUE_FILE, 'utf8').trim();
    if (!content) {
      console.log('Queue is empty.');
      return;
    }

    const lines = content.split('\n');
    const events = [];
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        console.warn('Skipping malformed line:', line);
      }
    }

    if (events.length === 0) {
      console.log('No valid events to process.');
      fs.writeFileSync(QUEUE_FILE, ''); // Clear file
      return;
    }

    // Sort by timestamp (ascending - oldest first)
    events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    console.log(`Processing ${events.length} events in order...`);

    const failed = [];
    
    for (const event of events) {
      const script = event.direction === 'in' ? 'log-inbound.mjs' : 'log-outbound.mjs';
      const phoneArg = event.direction === 'in' ? '--from' : '--to';
      
      try {
        console.log(`  [${event.ts}] ${event.direction.toUpperCase()} ${event.phone}: ${event.text.slice(0, 50)}...`);
        
        await runScript(script, [
          '--logsDs', args.logsDs,
          '--contactsDs', args.contactsDs,
          phoneArg, event.phone,
          '--text', event.text,
          '--time', event.ts,
        ]);
        
        console.log(`    ✓ logged`);
      } catch (err) {
        console.error(`    ✗ failed: ${err.message}`);
        failed.push(event);
      }
    }

    // Rewrite queue with only failed events (for retry)
    if (failed.length > 0) {
      console.log(`${failed.length} events failed, will retry next run.`);
      fs.writeFileSync(QUEUE_FILE, failed.map(e => JSON.stringify(e)).join('\n') + '\n');
    } else {
      // Clear the queue
      fs.writeFileSync(QUEUE_FILE, '');
      console.log('All events processed successfully.');
    }
  } finally {
    releaseLock();
  }
}

processQueue().catch(err => {
  console.error('Worker error:', err);
  releaseLock();
  process.exit(1);
});
