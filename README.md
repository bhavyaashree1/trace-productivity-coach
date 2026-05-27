# Focus Flow Coach

Focus Flow Coach is a hybrid Trace skill that helps users track focus sessions, energy levels, break timing, work patterns, and context-aware productivity signals.

It combines:
- **MCP dialog** for voice-first interaction
- **Webhook ingestion** for passive device/media context
- **Persistent storage** for session history and pattern analysis
- **Connector-aware responses** for calendar, email, Instagram, Calendly, and Facebook workflows
- **Proactive nudges** via scheduled background checks

This repository is built on top of the Trace skill template and adapted into a Railway-deployable, database-backed productivity skill.

---

## What the skill does

Focus Flow Coach helps users:

- Start and end work sessions
- Log energy and headspace
- Ask when to take a break
- Get next-task recommendations
- Block time on calendar
- Build productivity summaries and patterns
- Use passive visual/device context for soft truth-checking
- Get nudges when connector integrations are missing

### Example user requests

- “I’m starting deep work on investor deck”
- “My energy is high”
- “When should I take a break?”
- “What should I work on right now?”
- “Block this on my calendar”
- “Analyze my email”
- “When am I most productive?”

---

## Project structure

```text
trace-bhavyaa-productivity-skill/
│
├── docs/
├── src/
│   ├── connectors.ts
│   ├── db.ts
│   ├── hmac.ts
│   ├── index.ts
│   ├── insights.ts
│   └── types.ts
│
├── .env
├── .env.example
├── .gitignore
├── deploy.sh
├── manifest.json
├── package-lock.json
├── package.json
├── Procfile
├── railway.json
├── README.md
├── TRACE_SKILL_LLM_CONTEXT.md
└── tsconfig.json