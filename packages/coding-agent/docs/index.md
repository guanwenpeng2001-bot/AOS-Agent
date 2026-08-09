# AOS Agent documentation

AOS Agent is a standalone terminal coding agent. It stays small at the core and can be extended with TypeScript extensions, skills, prompt templates, themes, and package resources.

## Quick start

Build and install the repository baseline locally:

```bash
npm install --ignore-scripts
npm run build
npm install --global --ignore-scripts ./packages/coding-agent
aos --help
```

The build refreshes the ignored AOS-owned model registry under `.artifacts/aos-model-registry/`. See [`../../ai/AOS-MODEL-REGISTRY.md`](../../ai/AOS-MODEL-REGISTRY.md) for source review and update policy.

Then run `aos` in the project you want to work on. See [Quickstart](quickstart.md) for authentication and the first session.

## Start here

- [Quickstart](quickstart.md) — install, authenticate, and run a first session.
- [Using AOS Agent](usage.md) — interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) — subscription and API-key setup for built-in providers.
- [Security](security.md) — project trust, sandbox boundaries, and vulnerability reporting.
- [Settings](settings.md) — global and project settings.
- [Sessions](sessions.md) — session management, branching, and tree navigation.
- [Compaction](compaction.md) — context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) — TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) — reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) — reusable prompts that expand from slash commands.
- [Themes](themes.md) — built-in and custom terminal themes.
- [AOS Agent packages](packages.md) — bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) — add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) — implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) — embed the agent in Node.js applications.
- [RPC mode](rpc.md) — integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) — print mode with structured events.
- [TUI components](tui.md) — build custom terminal UI for extensions.

## Reference

- [Environment variables](environment-variables.md) — process configuration and session metadata available to bash tools.
- [Session format](session-format.md) — JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

For upstream provenance, licensing, and the maintenance boundary, see [`../../UPSTREAM.md`](../../UPSTREAM.md).
