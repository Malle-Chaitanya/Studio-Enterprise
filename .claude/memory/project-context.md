# Memory: Project Context

## What this is

**CloudFuze Studio Migrate** (repo `CS_GE`) is a production-grade, multi-tenant tool that
migrates **agents** from **Microsoft Copilot Studio** into **Google Gemini Enterprise**. It is a
rebuild of an earlier Python POC into a real service. Package names:
`cloudfuze-studio-migrate-server` and `cloudfuze-studio-migrate-web`.

## Who uses it

- **Customers**: an organization moving off Copilot Studio. Their **Microsoft admin** connects
  the Copilot/Dataverse side; their **Google admin** identifies the destination Gemini project.
- **CloudFuze**: operates the tool (a service account reaches each customer's Gemini project via
  Direct IAM or Domain-Wide Delegation). It is designed to run against *any* customer project
  unchanged — client-agnostic.
- Default app users are seeded (`admin@cloudfuze.com`, `demo@cloudfuze.com`) for the login layer.

## The user journey (web wizard)

Connect Platforms → Choose Pair → Select & Map → Select Data → (Dry Run) → Live Migration →
Report. Each step maps to a page in `web/src/pages/`.

## Scope

- **Phase 1 (now): agents only**, high-fidelity. Flows/workflows are a later phase.
- Per run, the customer picks a scope (one agent, an environment, the whole tenant, or an exact
  selection) — the pipeline below the scope is scope-agnostic.

## Product principles (the soul of the tool — do not violate)

1. **Lossless extraction** — capture everything from the source, even what v1 can't yet map;
   unmapped data still surfaces in the report.
2. **Behavioral fidelity** — the migrated agent should behave like the original. Read the *real*
   instructions/topics/AI-Builder prompts, not regex-scraped filler (the POC's failure).
3. **Honesty over overclaiming** — report what was mapped, lost, or needs review, truthfully.
   Never make the result look better than it is.
4. **Recommendations, not silent decisions** — surface choices (e.g. knowledge-source handling)
   to the customer; don't decide behind their back.

## Key external truth

Migrated agents appear in the Gemini **Business** edition UI but **not** in Standard/Plus (a
governed gallery). This is a documented finding, not a bug — see
[domain-knowledge.md](domain-knowledge.md) and `docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`.

## Tooling context

Development uses **gstack** (global at `~/.claude/skills/gstack/`) for generic workflows
(review/QA/security/ship) and this `.claude/` knowledge base for project-specific guidance. See
[CLAUDE.md](../../CLAUDE.md).