# CloudFuze Studio Migrate — Plain-English Overview

Sep 29, 2026 · @Kiran Ummenthala

## The idea in one paragraph

Some companies build chatbots inside Microsoft's Copilot Studio, and now want to switch to Google's Gemini instead. Doing that by hand means rebuilding every chatbot's brain, its knowledge, and every button it can push — one at a time, for every single chatbot. This tool does that move automatically: it reads each chatbot out of the Microsoft side, rebuilds it inside Google, and hands back a clear report of exactly what came across and what didn't.

## Who it's for

Two groups touch this. **The customer** — a company moving its chatbots off Microsoft — just needs one person who manages their Microsoft side and one who manages their Google side to log in once each; the tool does the rest. **CloudFuze** runs the tool itself, and it's built to work the same way for any customer — nothing is custom-built for one company, so it doesn't need to be re-built for the next one.

## How it works, step by step

1. **Log in to both sides.** The Microsoft admin and the Google admin each sign in once.
2. **Pick what to move.** One chatbot, a whole department, or the entire company — the customer chooses.
3. **Decide how each chatbot's documents should be handled** on the new side (uploaded files, SharePoint folders, wikis, and so on).
4. **Preview it first (optional).** See exactly what would happen — nothing is actually created yet.
5. **Do the real move.** Each chatbot is rebuilt, turned on, and shared with the right people.
6. **Get a report card.** Every chatbot gets its own scorecard: what came across faithfully, and what needs a second look.

## What's covered today

Right now this only moves **chatbots** — not other kinds of automation — but it aims to move them faithfully, not just superficially. That includes:

- The chatbot's core instructions — its personality, rules, and tone
- Its conversation flows and canned questions
- Its documents and knowledge (uploaded files, SharePoint, wikis, spreadsheets of data)
- Its integrations with other systems (Jira, HubSpot, Teams, Dropbox, Salesforce, and hundreds more) — read live from Microsoft's own records instead of a fixed list, so new ones keep getting added
- **Buttons the chatbot can press that are themselves a small automated flow** (a Power Automate flow one of its actions triggers) — these now get rebuilt as a real, working step too, not just noted in the report
- Who owns it and who's allowed to use it
- Whether it was already live for everyone or still a private draft

This works the same whether the customer moves one chatbot, one department, or their whole company at once.

## What's not covered yet

We'd rather tell you the limits up front than have you discover them later:

- **Stand-alone automated workflows** (ones not tied to any chatbot) aren't moved yet — only the flows a chatbot's own buttons trigger are covered so far. A full "move our workflows too" option is still a planned later phase, not built yet.
- **Fine-grained document access doesn't fully carry over.** If a folder was restricted to one team, that restriction may not be recreated automatically on the new side — we flag this rather than hide it.
- **Some integrations get broader access, not narrower.** If a tool acted "as whoever was chatting," it now acts as one shared account instead. We detect this and flag it; we don't yet fix it automatically.
- **Test question sets, switched-off features, and some interactive card designs** are noted in the report but not moved.
- **A few of Microsoft's ready-made chatbots** don't keep their real content anywhere we can read — these come across as an empty shell and need a person to fill them in.
- **Sharing with specific people isn't automatic on the new side.** Google only lets us turn on company-wide access automatically; sharing with one person or team is a manual checklist we hand over.

## Our promise

- **We don't throw anything away.** Even things we can't yet rebuild on the new side are recorded, so nothing is silently lost.
- **We copy real behavior, not just names.** We read what a chatbot actually does, not just what it's called.
- **We tell the truth about the result.** The report says what worked, what didn't, and what needs a second look — never a rosier picture than reality.
- **We ask, we don't decide for you.** When there's a judgment call, we bring it to the customer instead of guessing.

## Where things stand today

Moving chatbots (step 1 through the report card above) works start to finish today, with live progress you can watch as it happens, and now includes rebuilding the flows a chatbot's own buttons trigger. What's left: more automated testing behind the scenes, and a stand-alone workflow migration as the next phase.
