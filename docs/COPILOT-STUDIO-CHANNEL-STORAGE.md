# Copilot Studio Agent Channels — Where They Actually Live in Dataverse

**Purpose:** answer, with live evidence, whether an agent's published channels (Microsoft
Teams, Microsoft 365 Copilot, SharePoint, etc.) can be extracted, and where that data lives.
**Status:** confirmed via live probe against a real test tenant (CloudFuze Agent Migration Hub).
**Last updated:** 2026-08-20.

---

## Answer

**Yes — channel data is stored in Dataverse, in a structured, enumerable form**, inside the
`bots.configuration` column (a JSON blob this codebase already fetches, but does not yet
parse for this).

```json
"channels": [
  { "id": null, "channelId": "msteams", "channelSpecifier": null, "displayName": null },
  { "id": null, "channelId": "Microsoft365Copilot", "channelSpecifier": null, "displayName": null }
]
```

A second, independent corroborating signal lives in `bots.applicationmanifestinformation`
(also a JSON blob, also already fetched but unparsed for this):

- `copilotChat.isEnabled` — boolean, mirrors whether `Microsoft365Copilot` is in `channels[]`.
- `teams.botChannelRegistrationAppId`, `microsoft365.appId`, `microsoft365.shareLink` — per-agent
  app registration metadata tied to those channels (each agent has its own distinct `appId`,
  confirmed across 3 test agents — not a shared tenant-level value).

`bots.publishedon` / `bots.statecode` remain the separate, agent-level "was this ever
published" flag (already extracted, `dataverse.ts:1242-1261`) — publish state and channel
enablement are two different fields, consistent with [permission-migration-architecture.md](permission-migration-architecture.md)'s
distinction between publish state and access/sharing.

## Live evidence

Probed 3 real agents in the CloudFuze Agent Migration Hub test environment
(`https://org32322095.crm.dynamics.com`), via `GET bots({id})?$select=configuration,
applicationmanifestinformation,publishedon,statecode`:

| Agent | Published | `channels[]` | `copilotChat.isEnabled` |
|---|---|---|---|
| Knowledge Assistant | 2026-08-08 | `msteams`, `Microsoft365Copilot` | true |
| Migrate Advisor | 2026-08-16 | `msteams`, `Microsoft365Copilot` | true |
| Enterprise Agent | 2026-08-11 | `msteams`, `Microsoft365Copilot` | true |

None of the three had a `sharepoint` entry in `channels[]`. SharePoint appears to be
**dual-purpose** in Copilot Studio: a **knowledge-source connector** (already handled in this
codebase via `botcomponent` componenttype 16 — see
[knowledge-sources-migration-playbook.md](knowledge-sources-migration-playbook.md)) and,
separately, a native **deployment channel** per Microsoft's own docs. This has not yet been
confirmed live against an agent with SharePoint actually enabled as a channel — that's the
one open item below.

## What was checked and ruled out

- `botcomponent.componenttype` — 20 known enum values (Topic, Dialog, Trigger, Knowledge
  Source, Copilot Settings, etc.); none represent a channel. No `botchannel`/`channel` entity
  exists in the `bot` table's relationships either. **Channel data is not here.**
- Omnichannel is a wholly separate Dynamics 365 Customer Service module (its own adapter +
  Direct Line) — not a `bot`/`botcomponent`/`configuration` field at all.

## Implication for extraction

`server/src/services/dataverse.ts` already fetches `configuration` for every agent (used
today only by `parseAgentSettings()` and `parseConfigDescription()`, `dataverse.ts:1104-1137`).
The `channels` array is present in that same payload and currently discarded. Extracting it
into `AgentIR` would be a small addition to an existing fetch, not a new API call — worth doing
per the lossless-extraction principle, even before any Gemini-side channel mapping exists,
since Gemini Enterprise has no equivalent "channel" concept at all (its own access model is
license + engine role + per-agent `agentUser` grant — see
[design/PERMISSION-MAPPING-ARCHITECTURE.md](design/PERMISSION-MAPPING-ARCHITECTURE.md) Part B).
Channel data would therefore surface as report-only / `out of scope` context, not something
mapped to a destination equivalent.

## Open item

Confirm live against an agent that has **SharePoint enabled as a deployment channel** (not
just as a knowledge source) to see whether it appears in `channels[]` as `sharepoint` /
some other `channelId`, and whether `applicationmanifestinformation` carries a corresponding
block the way `teams`/`microsoft365` do for their channels.

## How this was probed (reusable)

Throwaway diagnostic spikes, read-only, following this repo's `_diag_*.ts` convention:
`server/src/spikes/_diag_channel_publish_probe.ts` and `_diag_channel_publish_probe2.ts`.
Run via `npx tsx src/spikes/_diag_channel_publish_probe.ts` from `server/`. Requires the
local `csge-mongodb` container running (for `environmentsCache` lookup) and a valid
`server/.env` with `MS_CLIENT_ID`/`MS_CLIENT_SECRET` app-only Dataverse credentials.
