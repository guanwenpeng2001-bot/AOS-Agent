# Contributing to AOS Agent

This guide exists to save both sides time.

## Philosophy

First things first: **AOS Agent's core is minimal**.

If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

AOS Agent's core exists to be minimal and to be extensible so that it can be influenced and manipulated by extensions.  Even hook points for extensions however should be well considered and discussed to avoid adding unmaintainable bloat and complex interactions.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Contribution Review

All issues and PRs are reviewed by an owner or maintainer. There is no automated contributor-gate workflow.

Issues submitted Friday through Sunday are not guaranteed to be reviewed.  If something is urgent, ask on Discord: https://discord.com/invite/3cU7Bz4UPx

Maintainers triage issues against the quality bar below and may close reports that do not meet it without replying.

Before opening a PR, get approval for the proposed change from an owner or maintainer. Approval allows the PR to be reviewed but does not guarantee that it will be merged.

## Quality Bar For Issues

If you open an issue, you must use one of the two GitHub issue templates.

If you open an issue, keep it short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice (do not use an LLM to generate text, if you must, follow up with a clearly AI labeled comment).
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

If the issue is real and written well, a maintainer may accept it for further investigation or implementation.

## Blocking

If you ignore this document twice, or if you spam the tracker with agent-generated issues, your GitHub account will be permanently blocked.

If you send a large volume of issues through automation, your GitHub account will be permanently blocked. No taksies backsies.

## Before Submitting a PR

Do not open a PR unless an owner or maintainer has approved the proposed change.

Before submitting a PR:

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit `packages/*/CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Questions?

Ask on [Discord](https://discord.com/invite/nKXTsAcmbT).

## FAQ

### Why are issues and PRs reviewed by maintainers?

AOS Agent receives more issues than the maintainers can responsibly review in real time. Many reports do not meet the quality bar in this guide or do not follow CONTRIBUTING.md. Some are slung at the repository mindlessly via an agent instead of being reviewed and shaped by the person submitting them. Owner or maintainer review keeps triage decisions with the people responsible for the project.

### Why are weekend issues lower priority?

We triage the tracker during working hours. That means more issues can accumulate over the weekend. Anything submitted Friday through Sunday may be missed or given lower priority in the Monday review queue. If a problem is urgent, ask on Discord and include the short version, a repro, and the relevant logs.

### Why do some issues get no reply?

A reply is maintenance work too. Low-signal issues, unclear reports, duplicates, and issues that do not follow this guide may be closed without discussion. This keeps time available for reproducible bugs, thoughtful requests, and contributors who have done the work to make their report actionable.

### Why not let AI triage everything?

AI can help group duplicates, summarize reports, and spot missing information. It is not trusted to make final maintainer decisions. Polished AI-generated issues can still be wrong, misleading, or expensive to investigate. Human review remains the final gate.

### Is this hostile to contributors?

No. It is a guardrail against burnout and tracker spam. Short, concrete, reproducible issues are welcome. Thoughtful contributions are welcome. Automated slop, entitlement, and large volumes of low-effort reports are not.

## Where can I learn about plans?

Earendil uses RFCs to discuss larger changes.  Not all of them are public, but
quite a few are.  They can be found at [rfc.earendil.com](https://rfc.earendil.com/).
