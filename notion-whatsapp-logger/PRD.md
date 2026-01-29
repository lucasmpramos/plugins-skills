# PRD: WhatsApp → Notion Daily Logs

**Version:** 3.0
**Last Updated:** 2026-01-29 02:57 UTC
**Author:** Bob (AI Agent)
**Status:** ✅ Production (with known limitations)

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
- ✅ Zero LLM tokens used (purely mechanical)
- ⚠️ Outbound messages may be truncated if long (known limitation)

---

## 2. Architecture

### 2.1 Final Working Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLAWDBOT GATEWAY                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    message_received    ┌──────────────────┐   │
│  │  WhatsApp   │ ────────────────────▶  │     Plugin:      │   │
│  │   Channel   │        hook            │ notion-whatsapp- │   │
│  └──────┬──────┘                        │     logger       │   │
│         │                               └────────┬─────────┘   │
│         │                                        │              │
│         │  auto-reply                  (inbound) │              │
│         │  (logs to gateway log)                 ▼              │
│         │                               ┌──────────────┐       │
│         └──────────────────────────────▶│  Queue File  │       │
│                  (truncated in log)     │   (JSONL)    │       │
│                                         └──────────────┘       │
│                                                  ▲              │
└──────────────────────────────────────────────────┼──────────────┘
                                                   │
┌──────────────────────────────────────────────────┼──────────────┐
│              SYSTEMD SERVICE (whatsapp-logger)   │              │
│                    Runs every 5 seconds          │              │
│                                                  │              │
│  ┌─────────────────┐                             │              │
│  │  poll-outbound  │─────────────────────────────┘              │
│  │    .mjs         │  (reads gateway log,                       │
│  └────────┬────────┘   extracts outbound msgs)                  │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────┐                                            │
│  │  queue-worker   │──────────────────────────▶ NOTION API      │
│  │    .mjs         │                                            │
│  └─────────────────┘                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Plugin | `.clawdbot/extensions/notion-whatsapp-logger/` | Hooks message_received, queues inbound text |
| poll-outbound.mjs | `workflows/whatsapp/logs-daily/` | Reads gateway log, extracts outbound msgs |
| queue-worker.mjs | `workflows/whatsapp/logs-daily/` | Processes queue, writes to Notion |
| queue-logger.mjs | `workflows/whatsapp/logs-daily/` | Manual queue append (for audio transcripts) |
| systemd service | `/etc/systemd/system/whatsapp-logger.service` | Runs poll + worker every 5 seconds |

### 2.3 Data Flow

#### Inbound Text Messages
```
1. WhatsApp message arrives
2. Gateway emits message_received hook
3. Plugin queues: { direction: "in", phone, text, ts }
4. Systemd service processes queue → Notion
```

#### Inbound Audio Messages
```
1. WhatsApp audio arrives
2. Plugin SKIPS (text starts with <media:>)
3. Whisper transcribes audio
4. Agent receives transcript
5. Agent manually queues: { direction: "in", phone, text: "🎤 {transcript}", ts }
6. Systemd service processes queue → Notion
```

#### Outbound Messages
```
1. Agent sends message (auto-reply)
2. Gateway logs to /tmp/clawdbot/clawdbot-YYYY-MM-DD.log
3. poll-outbound.mjs reads log, extracts "auto-reply sent" entries
4. poll-outbound.mjs queues: { direction: "out", phone, text, ts }
5. queue-worker.mjs processes queue → Notion
```

---

## 3. Configuration

### 3.1 Systemd Service

```ini
# /etc/systemd/system/whatsapp-logger.service
[Unit]
Description=WhatsApp Logger Worker
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/clawd/workflows/whatsapp/logs-daily
ExecStart=/bin/bash -c 'while true; do node poll-outbound.mjs; node queue-worker.mjs --logsDs e2424f80-10a1-4f77-86e3-9eb669915823 --contactsDs 48f14d6e-4606-4d4d-a594-fd91a0f83497; sleep 5; done'
Restart=always

[Install]
WantedBy=multi-user.target
```

### 3.2 Notion Data Sources

| Name | ID | Purpose |
|------|-----|---------|
| WhatsApp Logs Daily | `e2424f80-10a1-4f77-86e3-9eb669915823` | Daily log pages |
| Contacts | `48f14d6e-4606-4d4d-a594-fd91a0f83497` | Contact lookup |

### 3.3 Files

| File | Purpose |
|------|---------|
| `/tmp/whatsapp-log-queue.jsonl` | Event queue |
| `/tmp/whatsapp-log-queue.lock` | Worker lock file |
| `outbound-state.json` | poll-outbound position/seen state |

---

## 4. Known Problems & Limitations

### 4.1 🔴 Outbound Message Truncation

**Problem:** Gateway log truncates long messages with `… (truncated XX chars)`

**Impact:** Outbound messages >~300 chars appear truncated in Notion

**Root Cause:** Clawdbot's logging subsystem truncates text in log entries

**Attempted Solutions:**
1. ❌ Hook `message_sent` - Not called by Clawdbot (documented but not implemented)
2. ❌ Hook `message_sending` - Not called by Clawdbot (documented but not implemented)  
3. ❌ Hook `after_tool_call` - Only catches message tool, not auto-reply
4. ❌ Read from session files - Gets full text but also captures old messages
5. ✅ Accept truncation - Current workaround

**Future Fix:** PR to Clawdbot to implement `message_sending` or `message_sent` hooks

### 4.2 🟡 Audio Requires Manual Logging

**Problem:** Plugin receives audio before Whisper transcribes

**Impact:** Agent must manually log transcript after receiving it

**Current Solution:** Agent calls queue-logger.mjs with 🎤 prefix

### 4.3 🟡 Cron Jobs Unreliable

**Problem:** Clawdbot cron jobs use LLM, expensive and failed due to rate limits

**Attempted Solutions:**
1. ❌ Clawdbot cron with agentTurn - Uses tokens, hit rate limit
2. ❌ Clawdbot cron with different model - Model not allowed
3. ✅ Systemd service - Zero tokens, runs every 5 seconds

### 4.4 🟡 Session File Approach Broken

**Problem:** Reading from session files captures ALL historical messages

**Impact:** Floods Notion with hundreds of old messages

**Root Cause:** Session files contain full conversation history, not just new messages

**Solution:** Abandoned this approach, use gateway log instead

### 4.5 🟢 Duplicate Messages (Resolved)

**Problem:** Same message logged multiple times

**Root Cause:** 
- Hash collision in early poll-outbound implementation
- Multiple workers running simultaneously
- State file reset during debugging

**Solution:** 
- SHA1 hash on full message content
- Lock file prevents concurrent workers
- Careful state management

---

## 5. Operational Procedures

### 5.1 Service Management

```bash
# Check status
sudo systemctl status whatsapp-logger

# Restart
sudo systemctl restart whatsapp-logger

# View logs
journalctl -u whatsapp-logger -f

# Stop (for debugging)
sudo systemctl stop whatsapp-logger
```

### 5.2 Manual Queue Processing

```bash
# Process queue manually
node queue-worker.mjs \
  --logsDs e2424f80-10a1-4f77-86e3-9eb669915823 \
  --contactsDs 48f14d6e-4606-4d4d-a594-fd91a0f83497
```

### 5.3 Logging Audio Transcripts (Agent Must Do This)

```bash
node queue-logger.mjs \
  --direction in \
  --phone "+553196348700" \
  --text "🎤 {transcript}" \
  --time "{original_timestamp_ISO}"
```

### 5.4 Debugging

```bash
# Check queue
cat /tmp/whatsapp-log-queue.jsonl

# Check plugin loaded
grep "notion-whatsapp-logger" /tmp/clawdbot/clawdbot-*.log | tail -5

# Check for errors
grep -i error /tmp/clawdbot/clawdbot-*.log | tail -20

# Reset outbound state (if capturing old messages)
echo '{"pos":0,"seen":{}}' > outbound-state.json

# Clear queue (nuclear option)
> /tmp/whatsapp-log-queue.jsonl
```

### 5.5 Recovery from Broken State

```bash
# 1. Stop service
sudo systemctl stop whatsapp-logger

# 2. Clear queue
> /tmp/whatsapp-log-queue.jsonl

# 3. Reset state to current log position
node -e "
const fs = require('fs');
const size = fs.statSync('/tmp/clawdbot/clawdbot-$(date -u +%F).log').size;
fs.writeFileSync('outbound-state.json', JSON.stringify({pos:size,seen:{}}));
"

# 4. Restart
sudo systemctl start whatsapp-logger
```

---

## 6. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-28 | Initial poll.mjs implementation |
| 1.1 | 2026-01-28 | Added log-inbound.mjs / log-outbound.mjs |
| 2.0 | 2026-01-29 | Plugin + queue architecture |
| 3.0 | 2026-01-29 | Systemd service, documented problems, accepted truncation |

---

## 7. Future Improvements

1. **Fix truncation:** PR to Clawdbot implementing `message_sending` hook
2. **Auto audio logging:** Hook in plugin to detect when transcript is ready
3. **Better deduplication:** Use Notion API to check before inserting
4. **Multi-contact support:** Dynamic phone number handling

---

## 8. Contact

- **System Owner:** Luke
- **Implemented By:** Bob (AI Agent)
- **Repository:** `/home/ubuntu/clawd/workflows/whatsapp/logs-daily/`
- **GitHub:** `lucasmpramos/clawdbot-plugins`
