# CloudFuze Studio Migrate

Migrates **agents** from **Microsoft Copilot Studio** → **Google Gemini Enterprise**.

Production-grade rebuild of the Python POC. Phase 1 scope: **agents only** (high-fidelity).
Flows/workflows are a later phase.

## Architecture

```
extract → IR → map → create → verify → report
```

| Stage | Module | What it does |
|-------|--------|--------------|
| **extract** | `server/src/services/dataverse.ts` | Pulls the complete agent from Dataverse: real `instructions`, all topics, knowledge refs, starter prompts, entities → normalized `AgentIR` |
| **map** | `server/src/services/mapper.ts` | `AgentIR` → Gemini `lowCodeAgentDefinition` + high-fidelity instruction synthesis |
| **create** | `server/src/services/gemini.ts` | Create / publish / share via Discovery Engine `v1alpha` API, with quota backoff |
| **verify** | `server/src/services/verify.ts` | Smoke-tests each migrated agent |
| **report** | `server/src/services/report.ts` | Per-agent fidelity report (mapped / lost / needs-review) |

## Layout

```
server/   Node + TypeScript + Express API (OAuth, extraction, migration, SSE progress)
web/      React + Vite front-end (connect → review → migrate → report)
```

## Key difference from the POC

The POC discarded the agent's real instructions and regex-scraped 8 topics into generic
filler. This build reads the actual `GptComponentMetadata.instructions` from Dataverse and
synthesizes a faithful Gemini instruction from the full topic set. No secrets are committed —
all credentials come from environment / Secret Manager.

## Quick start

```bash
# backend
cd server && npm install && cp .env.example .env   # fill in .env
npm run dev

# frontend
cd web && npm install && npm run dev
```

See `server/.env.example` for required configuration.
