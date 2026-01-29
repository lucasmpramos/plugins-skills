# notion-whatsapp-logger

Clawdbot plugin that logs WhatsApp conversations to a Notion database with daily pages.

## Features

- 📥 Logs inbound messages (text + audio transcripts)
- 📤 Logs outbound messages
- 📅 Organizes by daily pages (one page per contact per day)
- 👥 Links to contacts database
- 🔄 Queue-based batching to reduce API calls

## Setup

1. Create a Notion integration and get the API key
2. Share your Notion workspace with the integration
3. Run `create-db.mjs` to create the database structure
4. Configure the data source IDs in your workflow

## Files

- `queue-logger.mjs` - Add messages to local queue
- `queue-worker.mjs` - Process queue and sync to Notion
- `create-db.mjs` - Initial database setup
- `PRD.md` - Full product requirements
- `ARCHITECTURE.md` - Technical architecture

## Usage

```bash
# Log a message
node queue-logger.mjs --direction in --phone "+5511999999999" --text "Hello!"

# Process queue
node queue-worker.mjs --logsDs <logs_datasource_id> --contactsDs <contacts_datasource_id>
```

## Environment

Requires `NOTION_TOKEN` environment variable or Clawdbot's Notion integration.
