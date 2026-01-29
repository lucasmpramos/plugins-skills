# PRD: WhatsApp → Notion Daily Logs

**Version:** 2.0 (Final Working)
**Last Updated:** 2026-01-29
**Author:** Bob (AI Agent)
**Status:** ✅ Production

---

## 1. Overview

### 1.1 Purpose
Automatically log all WhatsApp conversations to Notion, creating a searchable, organized archive with:
- One page per contact per day
- Messages in chronological order
- Audio transcripts included
- Timestamps in São Paulo timezone

### 1.2 Key Requirements
- ✅ Messages appear in correct chronological order
- ✅ Timestamps reflect actual event time (not processing time)
- ✅ Daily pages use São Paulo timezone (UTC-3)
- ✅ Audio messages include transcripts (not just `<media:audio>`)
- ✅ Both inbound and outbound messages logged
- ✅ No messages lost

---

## 2. Architecture

### 2.1 System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLAWDBOT GATEWAY                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    message_received    ┌──────────────────┐   │
│  │  WhatsApp   │ ────────────────────▶  │     Plugin:      │   │
│  │   Channel   │        hook            │ notion-whatsapp- │   │
│  └─────────────┘                        │     logger       │   │
│                                         └────────┬─────────┘   │
│                                                  │              │
│                                    (text only)   │              │
│                                                  ▼              │
│                                         ┌──────────────┐       │
│                                         │  Queue File  │       │
│                                         │   (JSONL)    │       │
│                                         └──────────────┘       │
│                                                  │              │
└──────────────────────────────────────────────────┼──────────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────┐
                    │           AGENT (Bob)        │              │
                    │                              │              │
                    │  1. Receives messages        │              │
                    │  2. For audio: queues        │              │
                    │     transcript with 🎤       ▼              │
                    │  3. For outbound: queues  ┌──────────────┐  │
                    │     before sending        │ Queue Worker │  │
                    │  4. Runs queue worker ───▶│   (manual)   │  │
                    │     after responding      └──────┬───────┘  │
                    │                                  │          │
                    └──────────────────────────────────┼──────────┘
                                                       │
                                                       ▼
                                              ┌──────────────┐
                                              │    Notion    │
                                              │  Daily Logs  │
                                              │   Database   │
                                              └──────────────┘
```

### 2.2 Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Plugin | `.clawdbot/extensions/notion-whatsapp-logger/index.ts` | Hooks message_received, queues text messages |
| Queue Logger | `workflows/whatsapp/logs-daily/queue-logger.mjs` | Appends events to queue file |
| Queue Worker | `workflows/whatsapp/logs-daily/queue-worker.mjs` | Processes queue, writes to Notion |
| Log Inbound | `workflows/whatsapp/logs-daily/log-inbound.mjs` | Creates/updates Notion pages (inbound) |
| Log Outbound | `workflows/whatsapp/logs-daily/log-outbound.mjs` | Creates/updates Notion pages (outbound) |

### 2.3 Data Flow

#### Text Messages (Inbound)
```
1. WhatsApp message arrives
2. Gateway emits message_received hook
3. Plugin checks: is it text? (not <media:*>)
4. Plugin queues: { direction: "in", phone, text, ts }
5. Agent processes queue after responding
6. Worker calls log-inbound.mjs → Notion
```

#### Audio Messages (Inbound)
```
1. WhatsApp audio arrives
2. Gateway emits message_received hook
3. Plugin checks: is it audio? (<media:audio>)
4. Plugin SKIPS (does not queue)
5. Whisper transcribes audio (async)
6. Agent receives message WITH transcript
7. Agent queues: { direction: "in", phone, text: "🎤 {transcript}", ts: original }
8. Agent processes queue
9. Worker calls log-inbound.mjs → Notion
```

#### Outbound Messages
```
1. Agent queues: { direction: "out", phone, text, ts }
2. Agent sends message via message tool
3. Agent processes queue
4. Worker calls log-outbound.mjs → Notion
```

---

## 3. Configuration

### 3.1 Gateway Config (`~/.clawdbot/clawdbot.json`)

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

### 3.2 Notion Data Sources

| Name | ID | Purpose |
|------|-----|---------|
| WhatsApp Logs Daily | `e2424f80-10a1-4f77-86e3-9eb669915823` | Daily log pages |
| Contacts | `48f14d6e-4606-4d4d-a594-fd91a0f83497` | Contact lookup |

### 3.3 Cron Jobs (Both Disabled)

| Job ID | Name | Status | Reason |
|--------|------|--------|--------|
| `ce87f2b9-4d0f-479c-b512-701de1409a2f` | Legacy poller | DISABLED | Replaced by plugin |
| `3caf7e7f-90fe-4615-84b7-045ae77926d2` | Queue worker | DISABLED | Manual processing only |

---

## 4. File Specifications

### 4.1 Queue File (`/tmp/whatsapp-log-queue.jsonl`)

JSONL format, one event per line:
```json
{"direction":"in","phone":"+553196348700","text":"message text","ts":"2026-01-29T01:28:56.000Z","logged":false}
```

| Field | Type | Description |
|-------|------|-------------|
| direction | "in" \| "out" | Inbound or outbound |
| phone | string | E.164 phone number |
| text | string | Message content |
| ts | string | ISO 8601 timestamp (UTC) |
| logged | boolean | Processing flag |

### 4.2 Plugin (`index.ts`)

Key behaviors:
- Listens to `message_received` hook
- Extracts: `event.content`, `event.timestamp`, `hookCtx.channelId`
- Skips if `channelId !== "whatsapp"`
- Skips if `text.startsWith("<media:")` (audio/images)
- Queues synchronously via `fs.appendFileSync`

### 4.3 Queue Worker (`queue-worker.mjs`)

Key behaviors:
- Uses lock file to prevent concurrent runs
- Reads entire queue file
- Sorts events by timestamp (ascending)
- Processes sequentially (no parallelism)
- Clears queue on success, keeps failed events for retry

---

## 5. Timezone Handling

### 5.1 The Problem
- WhatsApp timestamps are in UTC
- Notion daily pages should be organized by São Paulo date
- 01:00 UTC on Jan 29 = 22:00 SP on Jan 28

### 5.2 The Solution

Both `log-inbound.mjs` and `log-outbound.mjs` convert timestamps:

```javascript
const TZ = 'America/Sao_Paulo';

function dateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
}

function timeKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(11, 19);
  return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }); // HH:MM:SS
}
```

---

## 6. Error Handling

### 6.1 Lost Messages
- Queue file persists until processed
- Failed events remain in queue for retry
- Lock file prevents race conditions

### 6.2 Duplicate Prevention
- `log-inbound.mjs` uses SHA1 hash of message content
- State stored in `~/.clawdbot/logs-daily-state.json`
- Duplicates are skipped silently

### 6.3 Gateway Restart
- Plugin re-registers hooks on restart
- Queue file survives restarts
- No message loss during brief outages

---

## 7. Operational Procedures

### 7.1 Processing the Queue

After each agent response:
```bash
node /home/ubuntu/clawd/workflows/whatsapp/logs-daily/queue-worker.mjs \
  --logsDs e2424f80-10a1-4f77-86e3-9eb669915823 \
  --contactsDs 48f14d6e-4606-4d4d-a594-fd91a0f83497
```

### 7.2 Logging Audio Transcripts

When agent receives audio with transcript:
```bash
node /home/ubuntu/clawd/workflows/whatsapp/logs-daily/queue-logger.mjs \
  --direction in \
  --phone "+553196348700" \
  --text "🎤 {transcript}" \
  --time "{original_timestamp}"
```

### 7.3 Logging Outbound Messages

Before sending via message tool:
```bash
node /home/ubuntu/clawd/workflows/whatsapp/logs-daily/queue-logger.mjs \
  --direction out \
  --phone "+553196348700" \
  --text "{message}" \
  --time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

### 7.4 Debugging

```bash
# Check plugin loaded
grep "registered message hooks" /tmp/clawdbot/clawdbot-*.log

# Check queue
cat /tmp/whatsapp-log-queue.jsonl

# Check gateway logs
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep notion-whatsapp
```

---

## 8. Known Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| `message_sent` hook not called | Can't auto-log outbound | Agent logs manually |
| Audio hook fires before Whisper | No transcript in hook | Agent logs after receiving |
| No cron (race conditions) | Manual processing needed | Agent runs worker after responses |

---

## 9. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-28 | Initial poll.mjs implementation |
| 1.1 | 2026-01-28 | Added log-inbound.mjs / log-outbound.mjs |
| 2.0 | 2026-01-29 | Complete rewrite with plugin + queue architecture |

---

## 10. Contact

- **System Owner:** Luke
- **Implemented By:** Bob (AI Agent)
- **Repository:** /home/ubuntu/clawd/workflows/whatsapp/logs-daily/
