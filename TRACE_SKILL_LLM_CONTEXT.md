# Trace Skill Engineering Context (for LLMs)

You are an expert software engineer building a **Trace Skill** — a standalone web service that connects to the Trace AI glasses platform. This document is the complete reference for the platform contract. Follow it precisely.

A Skill receives events from glasses and the phone app (photos, voice, text, images), processes them, and responds with actions (notifications, reminders, emails, follow-up questions, etc.).

---

## 1. Architecture Overview

Trace Skills communicate via two interfaces. Most production skills are **Hybrid** (both).

| Interface | Use case | Execution model |
|---|---|---|
| **Webhook** | Passive background media processing (photos, audio, video) | Async: return `202`, process, POST callback |
| **MCP** | Interactive dialog + active media events | Sync: return result in the JSON-RPC response |
| **Hybrid** | Both — selects path per trigger | Active media → MCP; passive media → webhook; `instant.message` → MCP |

### Skill Interface Types
- `webhook` — only processes media events (always passive; no spoken response)
- `mcp` — handles dialog **and** active media channels (synchronous, can respond with voice + AWAIT_INPUT)
- `hybrid` — both; `routing_mode: active` media triggers with an MCP endpoint → MCP call; `routing_mode: passive` → webhook; `instant.message` active → MCP

### Channel semantics: `media.photo` vs `instant.image`

| Channel | When it fires | User context | Use for |
|---|---|---|---|
| `media.photo` | Glasses WiFi sync — photo arrives after the session | User is NOT actively talking | Silent background logging, enrichment, categorization |
| `instant.image` | Real-time AI photo during active conversation ("what's this?", phone image chat) | User IS actively asking | Spoken response, AWAIT_INPUT follow-up, real-time analysis |

Always subscribe to `instant.image` (not `media.photo`) when you want to respond with voice or ask the user a follow-up question. The two channels are intentionally separate so skills can opt into one, both, or neither.

### Active vs Passive dispatch

`routing_mode` on any channel controls the dispatch path:

| routing_mode | Interface | Path | Skill can speak? | AWAIT_INPUT? |
|---|---|---|---|---|
| `passive` | webhook/hybrid | Webhook async job | No | Via callback (arrives later) |
| `active` | webhook only | Webhook async job (active priority) | No | Via callback |
| `active` | mcp/hybrid | **MCP synchronous call** | **Yes** | **Yes — immediately** |

**Use `instant.image` + `active` + MCP/hybrid when your skill needs to:**
- Speak a response after processing a real-time photo ("Logged! Anything to add?")
- Ask a follow-up question via AWAIT_INPUT right after image capture
- Return a real-time analysis to an active AI conversation

### File Structure
```
my-skill/
├── src/
│   ├── index.ts        # Express server
│   ├── hmac.ts         # Signature verification middleware
│   └── agents.ts       # AI / LLM logic
├── manifest.json
├── .env                # HMAC_SECRET, API keys
└── package.json
```

---

## 1a. manifest.json — Full Specification

The manifest is the single source of truth for how Trace routes events to your skill. Generate it first; all implementation decisions flow from it.

**Developers can upload `manifest.json` directly to the Trace Developer Console** (`/dashboard/skills/create → Import manifest.json`). The dashboard parses it and pre-fills the registration form — no manual entry needed.

### Complete manifest.json

```json
{
  "name": "My Skill",
  "description": "One sentence describing what this skill does for the user.",
  "version": "1.0.0",
  "interface": "hybrid",

  "endpoints": {
    "webhook": "https://your-server.com/webhook",
    "mcp":     "https://your-server.com/mcp"
  },

  "triggers": [
    { "channel": "instant.image",      "routing_mode": "active"  },
    { "channel": "media.photo",        "routing_mode": "passive" },
    { "channel": "instant.message", "routing_mode": "active"  }
  ],
  // instant.image — real-time photo taken during an active AI conversation (glasses "what's this?",
  //   phone image sent to chat). Active + mcp/hybrid → MCP synchronous call, skill can speak + AWAIT_INPUT.
  // media.photo  — WiFi-synced background photo. Use passive for silent logging; active-MCP also
  //   supported if you want a spoken response for background sync events.
  // instant.message — all voice/text turns (including AWAIT_INPUT follow-ups).

  "domains": {
    "event_journal": "Handle voice commands to start/end event journals, add notes, and set reminders during life events like weddings, trips, and concerts."
  },

  "execution": {
    "mode": "async"
  },

  "permissions": [
    "user.profile.read",
    "user.location.read"
  ],

  "allowedTools": ["mail.send"],

  "dataRetention": {
    "max_days": 90,
    "deletion_webhook": "https://your-server.com/delete-user"
  },

  "categories": ["lifestyle", "memory"],

  "isPrivate": false,

  "proactive": false
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Yes | 1–80 chars. Shown in Skill Store. |
| `description` | string | No | Max 500 chars. |
| `version` | string | Yes | Semver: `1.0.0` |
| `interface` | `webhook` \| `mcp` \| `hybrid` | Yes | See §1 |
| `endpoints.webhook` | URI | If `webhook` or `hybrid` | Your `/webhook` URL |
| `endpoints.mcp` | URI | If `mcp` or `hybrid` | Your `/mcp` URL |
| `endpoints.callback` | URI | No | Alternate callback target (rarely needed) |
| `triggers` | array | No | Which channels wake your skill |
| `triggers[].channel` | string | Yes | `instant.image`, `media.photo`, `media.video`, `media.audio`, `instant.message`, `device.context` |
| `triggers[].routing_mode` | `active` \| `passive` | No | Default `active`. Use `passive` for silent background processing. |
| `triggers[].filter` | object | No | `{"hasImage": true}`, `{"source": "phone_image"}`, etc. |
| `domains` | object | No | Keys are domain names, values describe what utterances/images to route. Required when using `instant.message` or media triggers. |
| `execution.mode` | `sync` \| `async` | Yes | Always `async` for `media.*` channels. |
| `permissions` | array | No | Only `user.profile.read` and `user.location.read` are accepted. Channel-implied permissions are added automatically — do not repeat them here. |
| `allowedTools` | array | No | `mail.send`, `calendar.create` |
| `dataRetention.max_days` | number | Yes | 1–730 |
| `dataRetention.deletion_webhook` | URI | Yes | Called when user uninstalls your skill. |
| `categories` | array | No | Store browsing tags, e.g. `productivity`, `health`, `memory` |
| `isPrivate` | boolean | No | If true, skill is never listed publicly even after approval. |
| `proactive` | boolean | No | Set `true` only if your skill uses `/api/skill-push` proactively (requires review justification). |
| `proactiveReason` | string | If `proactive: true` | Min 20 chars. Explain what you push, when, and why it can't be user-triggered. |

### Rules for LLMs generating manifests

1. **`interface`** — set `webhook` if only processing media passively, `mcp` if only dialog or active media, `hybrid` if both.
2. **`execution.mode`** — always `async` if any `media.*` trigger is present (even active ones — the field refers to webhook async pattern, not MCP).
3. **`triggers`** — decide `routing_mode` by response need:
   - `passive` → silent background processing, no spoken response, webhook dispatch
   - `active` + `webhook` interface → active webhook (still async, no voice response)
   - `active` + `mcp`/`hybrid` interface → **MCP synchronous call**, skill can speak + issue AWAIT_INPUT
4. **Use `instant.image` for real-time AI photos, `media.photo` for WiFi-sync background photos.** They are separate channels: `instant.image` fires during an active AI conversation (glasses "what's this?", phone image chat); `media.photo` fires when glasses sync photos over WiFi after the session.
5. **`domains`** — required for `instant.message` (active routing) and for media channels where content-based routing matters. Describe both dialog utterances AND media content types your skill handles in one description.
6. **`permissions`** — omit `notification.send` and channel-implied permissions (e.g. `media.photo.read`); the platform derives these automatically.
7. **`allowedTools`** — only include tools your skill actually calls via `tool_call` responses.
8. **`deletion_webhook`** — must point to a real endpoint that deletes all user data when called.
9. **Active media MCP (`instant.image`)** — your `handle_dialog` tool receives `items[]` with the image URL and `context.source = "instant_image"`. `utterance` is empty for glasses captures, non-empty if the user spoke alongside the photo. Check `items` length before using image data.

---

## 2. Security: HMAC Verification

**Webhook** requests from Trace are signed. You must verify the signature before processing.

> **MCP calls are not signed.** The platform does not send `X-Trace-Signature` on JSON-RPC requests to your `/mcp` endpoint. Only apply HMAC verification on your `/webhook` route.

Headers sent by Trace (webhook only):
- `X-Trace-Signature: sha256=<hex>`
- `X-Trace-Timestamp: <unix_ms>`

Verification:
```typescript
import crypto from 'crypto';

function verifyHmac(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Use `express.raw({ type: 'application/json' })` before JSON parsing so `rawBody` is available.

---

## 3. Channel Taxonomy & Triggers

### Channels

| Channel | Source | When | Semantics |
|---|---|---|---|
| `media.photo` | Glasses | WiFi sync after session | Background photo arrived; user NOT in conversation |
| `media.video` | Glasses, Phone | WiFi sync | Background video arrived |
| `media.audio` | Glasses | WiFi sync | Background audio recording arrived |
| `instant.image` | Glasses, Phone | During active AI conversation | Real-time photo taken while user is talking ("what's this?") or phone image sent to chat |
| `instant.message` | Glasses, Phone | Real-time | Voice, text, or image+query from user |

**`instant.image` vs `media.photo`:** Use `instant.image` when you want to respond immediately with voice and optionally ask a follow-up. Use `media.photo` (passive) for silent background processing of WiFi-synced photos.

**Phone mode rule:** All phone inputs (image, voice, text) go to `instant.message` OR `instant.image` (phone images via AI chat). Phone video is the only exception — it goes to `media.video`.

### Trigger Configuration (in Developer Console)
```json
{
  "triggers": [
    { "channel": "media.photo", "routing_mode": "passive" },
    { "channel": "instant.message", "routing_mode": "active" }
  ]
}
```

`routing_mode`:
- `active` — platform selects your skill to handle this event; response is surfaced to the user
- `passive` — background fire-and-forget; response goes to activity feed only

### Trigger Filters for `instant.message`

You can narrow when your skill fires:

```json
{ "channel": "instant.message", "filter": { "hasImage": true } }
{ "channel": "instant.message", "filter": { "hasQuery": true } }
{ "channel": "instant.message", "filter": { "source": "phone_image" } }
{ "channel": "instant.message", "filter": { "source": ["phone_image", "phone_image_text", "phone_voice_image"] } }
// Match any image input including back-references (source: "ai_agent"):
{ "channel": "instant.message", "filter": { "hasImage": true } }
```

Supported filter keys:
- `hasImage: true` — only when user shares an image
- `hasQuery: true` — only when there is voice/text (non-image-only)
- `source: string | string[]` — specific input source(s)

---

## 4. instant.message Payload

Every `instant.message` event has a normalized payload. The platform pre-processes images (vision description) before dispatching.

**Webhook/MCP `event` object fields for `instant.message`:**

```json
{
  "channel": "instant.message",
  "source": "phone_voice_image",
  "query": "what's the calorie count?",
  "items": [
    {
      "id": "item_abc",
      "url": "https://s3.trace.ai/presigned/...",
      "mimeType": "image/jpeg",
      "imageDescription": "A plate with grilled chicken and rice, approximately 400g total."
    }
  ]
}
```

**`source` values:**

| Value | Meaning | query? | items? |
|---|---|---|---|
| `glasses_voice` | Voice from glasses (may include image capture — see below) | ✓ | ✓ image* |
| `phone_voice` | Voice from phone AI dialog | ✓ | — |
| `phone_text` | Typed text in phone chat | ✓ | — |
| `phone_image` | Photo from phone, no text | — | ✓ image |
| `phone_image_text` | Photo + typed text from phone chat | ✓ | ✓ image |
| `phone_voice_image` | Voice + photo simultaneously from phone | ✓ | ✓ image |
| `ai_agent` | Back-reference: user refers to a previously captured image ("save that", "add that receipt") | ✓ | ✓ image† |

**† Multi-turn back-reference (`ai_agent`):** When a user captures an image earlier in a session and later refers to it by pronoun or context ("save that", "log that image"), the platform resolves the prior image from session memory (up to 5 recent captures, 12-hour window) and dispatches on `instant.message` with `source: "ai_agent"`. The `items[0]` contains the original image URL and its pre-analysis description. Your skill **must** have an `instant.message` trigger to receive back-reference events — `media.photo` alone is not sufficient. Use `{ "hasImage": true }` as a filter to match both direct image inputs and back-references.

**Key fields:**
- `event.query` — the user's text or voice transcript (empty string if image-only)
- `event.items[0].url` — the image URL (if hasImage)
- `event.items[0].imageDescription` — GPT-4o vision pre-analysis (brief, for routing context)
- `pending_context` — injected at top level when this event answers a prior AWAIT_INPUT (see §7)

---

## 5. Webhook Specification

**Endpoint:** `POST /webhook`

### Async Pattern (required for media.*)
1. Validate HMAC signature
2. Return `202 Accepted` immediately
3. Process asynchronously
4. POST result to `body.callback_url`

### Request Payload Shape

```json
{
  "request_id": "uuid-abc",
  "callback_url": "https://api.trace.ai/skill-callback/...",
  "user": {
    "id": "proxied_user_id",
    "timezone": "Asia/Kolkata",
    "locale": "en-IN",
    "name": "Ishaan",
    "location": { "country": "IN", "city": "Delhi", "latitude": 28.61, "longitude": 77.20 }
  },
  "device": {
    "id": "proxied_device_id",
    "model": "trace-v1.1"
  },
  "skill": {
    "id": "nutrient-tracker",
    "version": "1.0.0"
  },
  "event": {
    "channel": "media.photo",
    "source": "wifi_sync",
    "items": [
      {
        "id": "item_xyz",
        "url": "https://s3.trace.ai/presigned/...",
        "mimeType": "image/jpeg",
        "thumbnailUrl": "https://s3.trace.ai/presigned/thumb/...",
        "imageDescription": "A plate of food with rice and curry",
        "captured_at": "2026-04-19T08:30:00Z",
        "tags": ["food", "lunch"]
      }
    ]
  },
  "context": {
    "session_id": null,
    "tags": []
  },
  "granted_permissions": ["user.profile.read"],
  "granted_integrations": ["gmail"]
}
```

> `pending_context` is added at the top level when this webhook fires as a follow-up to an AWAIT_INPUT you previously sent. See §7.

### Callback Response Shape

POST to `callback_url` with HMAC-signed body:

```json
{
  "request_id": "uuid-abc",
  "status": "success",
  "responses": [
    {
      "type": "notification",
      "content": { "title": "Meal Logged", "body": "500 kcal — chicken and rice" }
    },
    {
      "type": "feed_item",
      "content": { "feed_type": "skill", "title": "Logged 500 kcal lunch" }
    }
  ]
}
```

Sign the callback just like incoming requests: `sha256=hmac(secret, timestamp + "." + body)`.

### Sync Response (200) for `instant.message`

For `instant.message` events dispatched to a webhook (pending-context follow-ups for WEBHOOK-only skills), return 200 with the same `responses` array shape — no `request_id` or `status` wrapper needed, just the `responses` key.

---

## 6. MCP Specification (JSON-RPC 2.0)

**Endpoint:** `POST /mcp`

Trace calls `tools/list` on connect, then `tools/call` with the matched tool. The preferred entry tool name is `handle_dialog` (also accepted: `dialog`, `chat`, `ask`, `handle`).

### Tool Input Shape (`tools/call`)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "handle_dialog",
    "arguments": {
      "utterance": "what did I eat today?",
      "userId": "proxied_user_id",
      "deviceId": "proxied_device_id",
      "session_id": "uuid-session",
      "turn_index": 0,
      "context": {
        "source": "phone_voice",
        "query": "what did I eat today?",
        "hasImage": false,
        "imageDescription": null
      },
      "items": [],
      "user": {
        "id": "proxied_user_id",
        "timezone": "Asia/Kolkata",
        "locale": "en-IN",
        "name": "Ishaan",                    // only if user.profile.read granted
        "location": {                        // only if user.location.read granted
          "country": "IN",
          "city": "Delhi",
          "latitude": 28.6139,
          "longitude": 77.2090
        }
      },
      "pending_context": null
    }
  }
}
```

When the user sends a phone food photo (`phone_image`):
- `utterance` is `""` or the user's voice query
- `items` contains the image: `[{ "id": "...", "url": "...", "mimeType": "image/jpeg", "imageDescription": "..." }]`
- `context.hasImage` is `true`

When answering a previous AWAIT_INPUT:
- `pending_context` is populated — see §7

### MCP Response Shape

```json
{
  "content": [
    { "type": "text", "text": "You've had 1,200 kcal today across 3 meals." },
    {
      "type": "embedded_responses",
      "responses": [
        { "type": "notification", "content": { "title": "Today: 1,200 kcal", "body": "..." } },
        { "type": "set_reminder", "content": { "reminderText": "Log dinner", "time": "2026-04-19T19:00:00Z" } }
      ]
    }
  ]
}
```

The `text` content is spoken via TTS on the glasses. `embedded_responses` deliver side-effects (notifications, reminders, tool calls, AWAIT_INPUT).

### Multi-turn Sessions

Return `state: 'awaiting_input'` to keep a voice session open:
```json
{ "content": [...], "state": "awaiting_input" }
```
Default is `state: 'completed'`. Use `state: 'error'` to clear the session on failure.

---

## 7. AWAIT_INPUT — Cross-Dispatch Follow-up

`AWAIT_INPUT` lets a skill ask the user a question and receive the answer in a subsequent `instant.message` event, with the original context preserved. This works across separate dispatch events — e.g., a `media.photo` webhook can ask a follow-up that the user answers via voice.

### When to use it
- Photo analyzed but food not detected → ask what the user ate
- Low-confidence analysis → ask for confirmation/correction
- Media processed → need clarification before acting

### AWAIT_INPUT Response

Return from webhook callback (inside `responses`) or MCP `embedded_responses`:

```json
{
  "type": "await_input",
  "content": {
    "question": "I didn't spot food in that photo — what did you eat?",
    "context_key": "no_food_found",
    "context_payload": {
      "image_url": "https://...",
      "captured_at": "2026-04-19T08:30:00Z"
    },
    "allow_image": false,
    "timeout_ms": 300000
  }
}
```

| Field | Required | Description |
|---|---|---|
| `question` | Yes | Shown to user as a prompt on glasses/phone |
| `context_key` | No | Your own identifier for the pending state (auto-generated if omitted) |
| `context_payload` | No | Arbitrary JSON to persist — injected back on the follow-up dispatch (max 50 KB) |
| `allow_image` | No | If `true`, UI offers camera for the response |
| `timeout_ms` | No | Default 300s, max 600s |

**Limits:** max 3 active pending contexts per user, max 10 chained follow-up turns per skill.

### What the skill receives on the follow-up

The user's answer arrives as a normal `instant.message` event. The platform injects `pending_context` at the top level:

**Webhook payload:**
```json
{
  "event": {
    "channel": "instant.message",
    "source": "phone_voice",
    "query": "I had grilled chicken and rice",
    "items": []
  },
  "pending_context": {
    "context_key": "no_food_found",
    "context_payload": { "image_url": "...", "captured_at": "..." },
    "question": "I didn't spot food in that photo — what did you eat?",
    "turn_count": 1
  },
  "user": { ... }
}
```

**MCP toolInput:**
```json
{
  "utterance": "I had grilled chicken and rice",
  "pending_context": {
    "context_key": "no_food_found",
    "context_payload": { "image_url": "...", "captured_at": "..." },
    "question": "I didn't spot food in that photo — what did you eat?",
    "turn_count": 1
  }
}
```

The user's text is in `event.query` (webhook) or `utterance` (MCP). If the user responded with an image (`allow_image: true`), it's in `event.items[0]`.

### Routing note for Hybrid skills

For a **Hybrid** skill, all `instant.message` events (including pending-context follow-ups) are routed to the MCP `handle_dialog` tool. Only **Webhook-only** skills receive pending-context follow-ups at the webhook endpoint.

### Chaining follow-ups

Return another `AWAIT_INPUT` from the follow-up response to ask another question:
```
Turn 1: media.photo → no food → AWAIT_INPUT "What did you eat?"
Turn 2: instant.message "chicken salad" → log meal → AWAIT_INPUT "Any calorie target for today?"
Turn 3: instant.message "2000 kcal" → set goal → NOTIFICATION "Goal set: 2,000 kcal"
```

---

## 8. Response Types Reference

All responses use the same shape whether in a webhook callback or MCP `embedded_responses`:
```json
{ "type": "<type>", "content": { ... } }
```

### notification
```json
{
  "type": "notification",
  "content": {
    "title": "Meal Logged",
    "body": "Chicken and rice — 550 kcal",
    "tts": "Five hundred fifty calories logged.",
    "speak": false,
    "persist": true
  }
}
```

`speak: false` — suppress text-to-speech on the glasses speaker. Use this when the user is in a social setting (a wedding, concert, meeting) where a voice read-out would be disruptive. The notification still appears on the phone and in the activity feed.

### feed_item
```json
{
  "type": "feed_item",
  "content": { "feed_type": "skill", "title": "Logged 550 kcal lunch", "story": "..." }
}
```

### set_reminder
```json
{
  "type": "set_reminder",
  "content": { "reminderText": "Log dinner", "time": "2026-04-19T19:00:00Z" }
}
```

### set_todo
```json
{
  "type": "set_todo",
  "content": { "title": "Review meeting notes", "priority": "HIGH" }
}
```

### confirm_action
Platform shows a Yes/No prompt before executing the action.
```json
{
  "type": "confirm_action",
  "content": {
    "prompt": "Post this photo to Slack?",
    "on_confirm": { "type": "integration_action", ... },
    "on_decline": { "type": "notification", "content": { "title": "Cancelled" } },
    "timeout_ms": 30000
  }
}
```

### tool_call (Zero-OAuth)
Use the user's own connected accounts without ever seeing a token.
```json
{
  "type": "tool_call",
  "content": {
    "tool": "mail.send",
    "params": { "subject": "Meeting notes", "body": "...", "html": "..." },
    "on_result": "silent",
    "success_message": "Notes sent to your email.",
    "error_message": "Couldn't send — check your Gmail connection in Settings.",
    "speak": false
  }
}
```

**`on_result`** controls what happens after the tool executes:

| Value | Behaviour |
|---|---|
| `"silent"` | **(default)** Fire and forget. No success notification. A Pusher event is emitted so the web/app layer can react, but the user hears nothing extra. |
| `"notify_user"` | Send a push notification on success using `success_message` (or a generic "action completed" if omitted). |
| `"callback"` | POST the result (HMAC-signed) to your skill's `endpoints.callback` URL. Use when you need to chain logic after the action completes server-side. |

**`error_message`** — always fires as a push notification on failure, regardless of `on_result`. The platform sends this text if the tool call fails or the user hasn't connected their account. Omit to use the platform default ("Could not complete — try again").

**`speak: false`** — suppresses TTS for the success notification. Use this when the MCP `text` content already acknowledged the action out loud — otherwise the user hears two spoken confirmations.

Available tools: `mail.send` · `calendar.create`

### integration_action
Perform an action in a third-party service the user has connected (e.g. Google Photos, Notion, Slack).
Unlike `tool_call`, integration actions are dispatched through the platform's integration layer — the skill never sees tokens.
```json
{
  "type": "integration_action",
  "content": {
    "integration": "google_photos",
    "action": "add_to_album",
    "params": {
      "album_name": "Trip 2026",
      "image_url": "https://..."
    },
    "success_message": "Photo added to your Google Photos album.",
    "error_message": "Couldn't reach Google Photos — check your connection."
  }
}
```

Declare required integrations in the Developer Console under `allowedIntegrations`. The platform injects available integrations into `granted_integrations[]` on every request.

### await_input
See §7 above.

---

## 9. User Context & Permissions

Declare permissions in the Developer Console. Data is injected only if the user grants access.

```json
"user": {
  "id": "proxied_user_id",
  "timezone": "Asia/Kolkata",
  "locale": "en-IN",
  "name": "Ishaan",
  "location": {
    "country": "IN",
    "city": "Delhi",
    "latitude": 28.6139,
    "longitude": 77.2090
  }
}
```

| Permission | Fields unlocked |
|---|---|
| *(always)* | `id`, `timezone`, `locale` |
| `user.profile.read` | `name` |
| `user.location.read` | `location` |

**Always use `user.id` (proxy) as your DB primary key.** Never store or log it externally — treat it as an opaque stable identifier.

---

## 10. Agentic Patterns

### A. Persistence
Skills are stateless. Use a database keyed on `user.id`.
- **Recommended for hackathons:** SQLite via `better-sqlite3`
- **Production:** Postgres, MongoDB, Redis

### B. Proactive Push / Scheduling
To send a notification without a triggering event (daily summary, scheduled reminder):
```http
POST /api/skill-push/:skillId
Authorization: Bearer <HMAC_SECRET>
Content-Type: application/json

{
  "userId": "proxied_user_id",
  "responses": [
    { "type": "notification", "content": { "title": "Daily Report", "body": "..." } }
  ]
}
```

Use `node-cron` or a job queue to trigger this on a schedule. Store `user.id` + `callback_url` from the first event dispatch.

### C. Vision / Multimodal

**Two paths depending on `routing_mode`:**

**Passive (`media.photo` → webhook):** Background processing.
1. Download from `items[0].url` (presigned, expires in ~15 minutes — process promptly)
2. Run through a vision LLM (Gemini `gemini-2.0-flash`, GPT-4o)
3. Extract structured data, store result
4. Optionally return `await_input` in the callback to ask a follow-up question

**Active (`instant.image` + `routing_mode: active` + MCP/hybrid interface):** Synchronous, spoken response.

Platform calls `handle_dialog` with the image in `items[]`, same as a phone image dialog event:

```json
{
  "utterance": "",
  "userId": "proxied_user_id",
  "items": [{
    "id": "item_abc",
    "url": "https://s3.trace.ai/presigned/...",
    "mimeType": "image/jpeg",
    "imageDescription": "A plate with grilled chicken and rice."
  }],
  "context": {
    "source": "instant_image",
    "hasImage": true,
    "imageDescription": "A plate with grilled chicken and rice."
  },
  "user": { "id": "proxied_user_id", "timezone": "Asia/Kolkata" }
}
```

Your skill:
1. Receives the call synchronously
2. Runs vision LLM on `items[0].url`
3. Returns spoken text + optional AWAIT_INPUT in `embedded_responses`
4. User hears the response immediately; AWAIT_INPUT follow-up arrives via `instant.message`

`items[0].imageDescription` is a brief pre-analysis already attached by the platform (useful for routing context, not detailed enough for analysis). Run your own vision call for full analysis.

---

## 11. Enrichment Patterns — Linking Media and Context

The richest skills combine passive media capture with contextual enrichment from the user. There are four distinct patterns; most production skills use all of them.

### A. Photo-first → voice follow-up (AWAIT_INPUT)

The simplest enrichment loop: capture and analyze a photo, ask the user for context, receive their answer as a follow-up `instant.message`.

```
media.photo (passive webhook)
  → analyze image with vision LLM
  → insertMoment({ ...analysis, user_note: null })   ← no context yet
  → callback with AWAIT_INPUT:
      question: "Who are you with and what's happening?"
      context_key: "enrich_moment"
      context_payload: { moment_id, event_id, image_url }

  ↓ user answers by voice

instant.message (active → MCP handle_dialog)
  → pending_context.context_key === "enrich_moment"
  → extractEnrichment(utterance)
  → enrichMoment(moment_id, enrichment)
  → text: "Got it — [snippet], with [name]."   ← spoken ack only, NO second feed card
```

**Critical rule:** do not emit a second `feed_item` when enriching. The photo's card was already created at capture time. Return only a spoken `text` ack.

Handle the three user replies your AWAIT_INPUT will receive:

```typescript
// User wants to skip
const isSkip = /^(skip|no note|no thanks|log it|ok|yes|sure|fine|sounds good)\b/i.test(utterance);
if (isSkip) return { content: [{ type: 'text', text: "Got it — moment saved as is." }] };

// User wants to remove the moment entirely
const isDelete = /^(remove|delete|discard|never mind|forget it|cancel)\b/i.test(utterance);
if (isDelete) { deleteMoment(moment_id); return { content: [{ type: 'text', text: "Got it — moment removed." }] }; }

// Otherwise — enrich
const enrichment = await extractEnrichment(utterance);
enrichMoment(moment_id, enrichment);
```

---

### B. Voice-first → photo follow-up (proximity linking)

The user narrates a moment ("Heading into the ceremony — so excited") then silently snaps a photo within the next 30–60 seconds. Without proximity linking, the photo arrives with no context and triggers an AWAIT_INPUT the user already answered verbally.

**Strategy:**
1. When a voice note arrives (MCP): insert a `voice_note` moment with a `captured_at` timestamp and an `is_paired` flag (default false).
2. When the next photo arrives (webhook or MCP): query for the most recent unpaired voice note within your proximity window.
3. If found: copy the voice note's `people`, `activity`, `user_note` onto the photo moment; mark the voice note as paired; **skip AWAIT_INPUT entirely**.

```typescript
// DB helper (SQLite example)
function getRecentVoiceNote(userId: string, withinSeconds: number) {
  return db.prepare(`
    SELECT * FROM moments
    WHERE user_id = ? AND type = 'voice_note' AND is_paired = 0
      AND captured_at >= datetime('now', '-' || ? || ' seconds')
    ORDER BY captured_at DESC LIMIT 1
  `).get(userId, withinSeconds);
}

// In photo handler
const linkedNote = getRecentVoiceNote(userId, 45);
if (linkedNote) {
  insertMoment({ ...photoFields, people: linkedNote.people, user_note: linkedNote.user_note });
  markVoiceNotePaired(linkedNote.moment_id, photoMomentId);
  // speak: "Got it — photo linked to '[note snippet]'."  No AWAIT_INPUT.
}
```

This applies in **both** the webhook (`media.photo` passive) and MCP (`instant.image` active) handlers — always check for a linked note before deciding whether to ask a follow-up.

---

### C. Late enrichment (user adds context minutes later)

A common pattern: the user snaps a photo silently, continues the experience, then says "that was Priya's speech" or "at the Taj Mahal" 2–10 minutes later. Without late enrichment, this gets classified as a new voice note.

**Detection — two layers:**

**Layer 1: fast regex** (run before LLM classification):
```typescript
function looksLikeLateEnrichment(utterance: string): boolean {
  if (utterance.trim().length > 140) return false; // long text = new beat
  return /^(that was|it was|those were|that's|this was|we were|they were|with my|at the|in the)\b/i.test(utterance.trim());
}
```

**Layer 2: LLM intent** — include `"late_enrichment"` as a possible intent in your classification prompt, returning the enrichment context in a structured field. Use this as a fallback when the regex doesn't catch it.

**On match:** query for the most recent unenriched photo within your window (e.g. 10 minutes), apply enrichment, ack with a spoken line — no new feed card.

```typescript
const recent = getRecentUnenrichedPhoto(userId, 600); // 10-min window in seconds
if (recent) {
  const enrichment = await extractEnrichment(utterance);
  enrichMoment(recent.moment_id, enrichment);
  return { content: [{ type: 'text', text: `Got it — ${snippet}.` }] };
}
// No recent photo → fall through to voice_note intent
```

---

### D. Image as follow-up to a voice note (`allow_image: true`)

When you log a voice note and want to let the user attach a photo:

```json
{
  "type": "await_input",
  "content": {
    "question": "Snap a photo to go with it, or say \"skip\" when you're done.",
    "context_key": "enrich_moment",
    "context_payload": { "moment_id": "...", "event_id": "..." },
    "allow_image": true
  }
}
```

On the follow-up dispatch, check `items` first — the user may have responded with a photo, text, or both:

```typescript
// MCP pending_context handler
const imageItems = toolInput.items?.filter(item => item.mimeType?.startsWith('image/')) ?? [];

if (imageItems.length > 0) {
  // User sent a photo as their follow-up
  const analysis = await analyzePhoto(imageItems[0].url);
  insertPhotoMoment({ ...analysis, linkedVoiceNoteId: context_payload.moment_id });
  return { content: [{ type: 'text', text: "Got it — photo saved with your note." }] };
}

if (utterance.trim() && !isSkip(utterance)) {
  // User added more text context
  enrichMoment(context_payload.moment_id, await extractEnrichment(utterance));
  return { content: [{ type: 'text', text: "Got it — note updated." }] };
}
```

---

### E. Spoken ack formula

Keep enrichment acknowledgements short and natural for TTS:

```
"Got it — [note snippet][, with [name(s)]][, at [location]]."
```

Rules:
- Strip trailing punctuation from the snippet before embedding it
- Max ~90 chars before truncation with `…`
- Omit the relationship noun if `people` contains only relationship terms ("wife", "mom") — they read awkwardly as "with wife"
- Never say "logged" or "saved" twice in one turn if the primary `text` content already said it

---

## 12. Development Workflow

1. **Local testing:** expose with `ngrok`. Set the ngrok URL in the Developer Console.
2. **Deployment:** Railway, Render, or any VPS. Ensure the endpoint is publicly accessible.
3. **Validate payloads:** log `req.body` on first run to understand the exact shape for your channel.
4. **HMAC in dev:** temporarily log the expected vs received signature if verification fails — check that you're using `rawBody`, not the parsed JSON. Remember: HMAC verification applies to `/webhook` only — do not add it to `/mcp`.

---

## 13. LLM Counselor Guidelines

When helping a developer build a Trace Skill:

1. **Start with the manifest** — define channels, routing_mode, and domains first.
2. **Security is non-negotiable** — always include HMAC verification in the first draft.
3. **Pick the right interface** — silent background processing → webhook + passive; spoken/interactive response → MCP or hybrid + active.
4. **Async by default for media** — always `202 → callback` for passive `media.*` webhooks. Active `media.photo` on MCP/hybrid is synchronous (no 202 needed).
5. **Use AWAIT_INPUT instead of state hacks** — if a skill needs clarification before acting, return `await_input`. Don't try to manage conversation state manually.
6. **Items, not payload** — media URLs are in `event.items[0].url` (webhook) or `toolInput.items[0].url` (MCP). Not in `event.payload.url`.
7. **Proxy IDs only** — `user.id` is a proxy. Use it as DB key. Never expose or log real user identifiers.
8. **`context_payload` for follow-ups** — store all state the skill needs in `context_payload` when returning `await_input`. Don't rely on in-memory state across dispatch events.
9. **Hybrid skills: MCP gets all dialog and active media** — for hybrid skills, all `instant.message` events (including pending-context follow-ups) and active `media.*` events route to MCP. Check `pending_context` in `toolInput` before running intent classification.
10. **Handle `items` in MCP** — for phone images, glasses real-time captures (`instant.image`), and any `instant.message` with `hasImage: true`, inspect `toolInput.items` for image URLs. `instant.image` MCP calls have `context.source = "instant_image"`; `utterance` is `""` for a silent glasses snap, or non-empty if the user spoke alongside the photo (treat it as a note or query about the image).
11. **`instant.message` trigger required for back-references** — if a skill should respond when users say "save that" or "add that image" after capturing a photo, it **must** declare an `instant.message` trigger (active routing). A `media.photo`-only skill will never receive back-reference dispatches. Use `{ "hasImage": true }` as the filter to match both direct image inputs and back-references in one trigger.
12. **`phone_image_text` vs `phone_image`** — `phone_image_text` is sent when the user attaches an image AND types a text query in the phone chat. `phone_image` is photo-only with no text. If your skill needs either, filter on `{ "source": ["phone_image", "phone_image_text"] }` or simply `{ "hasImage": true }`.
13. **`instant.image` + AWAIT_INPUT pattern** — the recommended pattern for glasses real-time photo skills: declare `instant.image` active on a hybrid/mcp skill, process the image in `handle_dialog`, log the result, and return `await_input` asking for context ("Anything to add?"). The user's voice reply arrives as a normal `instant.message` event with `pending_context` injected. Use `media.photo` (passive) for WiFi-sync background logging where no spoken response is needed.
14. **Human line in `text`** — Put the sentence the user should hear in `content[].type === "text"`. On active MCP paths the platform may run a **surface response** pass (warm, concise rewrite) before TTS — skills should still return a short factual stub (e.g. `Note saved.`, `Photo saved · Wedding`) rather than long robotic copy. Do not rely on `feed_item` for TTS. `embedded_responses` are side-effects (feed, await, reminders) with `speak: false`.
19. **AWAIT_INPUT decisions** — Use an LLM to decide *whether* to ask (not regex templates). Ask only when missing context would hurt the memory; skip when the user already spoke, proximity-linked a voice note, or the scene is complete. Scrapbook reference: `communicationPolicy.ts` (`decideFollowUp`, `decideVoiceFollowUp`, `classifyEnrichReply`).
15. **No duplicate feed on enrich** — After a photo/voice capture, `await_input` follow-ups update SQLite only; do not emit another generic `feed_item` ("Moment updated"). The capture card is enough.
16. **Feed titles** — Short, user-centric titles (note snippet, activity, tags) — not a truncated vision paragraph.
17. **Reference implementation** — Copy patterns from `skills-server/src/skills/scrapbook/`: hybrid manifest, `pending_context`, `embedded_responses`, SQLite keyed on `user.id`, auto-wrap prior event on `start_event`. See §11 for enrichment patterns (photo-first, voice-first, late enrichment, image follow-up).
18. **Location** — Request `user.location.read`. Read `toolInput.user.location` (lat/lng/city). Mobile clients sync profile location via `LocationSyncHandler`; brain also falls back to stored profile coords when the request omits them.
