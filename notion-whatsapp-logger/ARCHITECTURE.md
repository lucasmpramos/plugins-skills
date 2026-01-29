# WhatsApp → Notion Logs (Daily pages) — Final Architecture

## Goal
Keep WhatsApp conversations mirrored into Notion with:
- Correct **ordering** (same order as WhatsApp)
- Correct **timestamps** (event time, not processing time)
- Correct **timezone** (São Paulo, not UTC)
- Audio **transcripts** (not just `<media:audio>`)

## Architecture (v2 - Working)

### Components

1. **Plugin** (`notion-whatsapp-logger`)
   - Location: `/home/ubuntu/clawd/.clawdbot/extensions/notion-whatsapp-logger/`
   - Hooks into `message_received` event
   - For **text messages**: queues to `/tmp/whatsapp-log-queue.jsonl`
   - For **audio/media**: SKIPS (will be logged by agent after transcription)

2. **Queue Logger** (`queue-logger.mjs`)
   - Appends events to the JSONL queue file
   - Used by plugin and by agent (for outbound + transcripts)

3. **Queue Worker** (`queue-worker.mjs`)
   - Reads queue, sorts by timestamp, writes to Notion
   - Run manually after each agent response
   - Uses lock file to prevent concurrent runs

4. **Log Scripts** (`log-inbound.mjs`, `log-outbound.mjs`)
   - Write to Notion and local markdown files
   - Handle contact lookup, daily page creation
   - Convert timestamps to São Paulo timezone

### Message Flow

#### Text Messages (Inbound)
1. Message arrives at gateway
2. `message_received` hook fires
3. Plugin queues event with original timestamp
4. Agent processes queue after responding

#### Audio Messages (Inbound)
1. Message arrives at gateway
2. `message_received` hook fires
3. Plugin SKIPS (text is `<media:audio>`)
4. Whisper transcribes audio
5. Agent receives message with transcript
6. Agent queues transcript with original timestamp (🎤 prefix)
7. Agent processes queue

#### Outbound Messages
1. Agent queues message before sending
2. Agent sends via `message` tool
3. Agent processes queue

### Timezone Handling

The `dateKey()` function converts timestamps to São Paulo timezone:
```javascript
function dateKey(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}
```

This ensures messages at 01:00 UTC on Jan 29 appear on the Jan 28 page (22:00 SP).

### Config (Gateway)

```json
{
  "plugins": {
    "entries": {
      "notion-whatsapp-logger": {
        "enabled": true,
        "config": {
          "logsDs": "e2424f80-10a1-4f77-86e3-9eb669915823",
          "contactsDs": "48f14d6e-4606-4d4d-a594-fd91a0f83497"
        }
      }
    }
  }
}
```

### Cron Jobs (Both Disabled)

- `ce87f2b9-4d0f-479c-b512-701de1409a2f` - Legacy poller (DISABLED)
- `3caf7e7f-90fe-4615-84b7-045ae77926d2` - Queue worker (DISABLED - manual only)

## Known Limitations

1. **`message_sent` hook not implemented**: Clawdbot defines it but never calls it.
   Agent must manually queue outbound messages.

2. **Audio transcription is async**: Hook fires before Whisper runs.
   Agent logs transcript after receiving it.

3. **Manual queue processing**: Cron jobs cause race conditions.
   Agent processes queue at end of each response.

## Debug Checklist

1. Check gateway is running: `systemctl --user status clawdbot-gateway`
2. Check plugin loaded: `grep "registered message hooks" /tmp/clawdbot/clawdbot-*.log`
3. Check queue file: `cat /tmp/whatsapp-log-queue.jsonl`
4. Run worker manually: `node queue-worker.mjs --logsDs ... --contactsDs ...`
5. Check Notion credentials: `~/.config/notion/api_key`
