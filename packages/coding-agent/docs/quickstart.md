# Quickstart

This page gets you from a local repository checkout to a useful first AOS Agent session.

## Install the published CLI

The current public release is `aos-agent@0.85.1`:

```bash
npm install --global aos-agent@0.85.1
aos --help
```

The immutable Git tag `v0.85.1` identifies that release snapshot. Later maintenance commits on `main` are not part of the tagged release or its package artifact. The earlier `v0.85.0` tag remains immutable.

## Install from source for development

From the repository root, build the workspace and install the CLI into an npm prefix:

```bash
npm install --ignore-scripts
npm run build
npm install --global --ignore-scripts ./packages/coding-agent
```

The build generates the local AOS-owned model registry described in [`../../ai/aos-model-registry.md`](../../ai/aos-model-registry.md). Do not redistribute generated output until each source's terms boundary has been reviewed.

Then start the agent in the project directory it should work on:

```bash
cd /path/to/project
aos
```

Use `aos --help` to confirm the executable and see all supported options. The default user data directory is `~/.aos-agent/agent`; project-local settings and resources live under `.aos-agent/`.

### Uninstall

Remove the package from the same npm prefix used for installation:

```bash
npm uninstall -g aos-agent
```

Uninstalling the package does not remove settings, credentials, sessions, or installed agent packages under `~/.aos-agent/agent/`.

## Authenticate

AOS Agent can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Subscription login

Start `aos`, run `/login`, and select a provider.

### API key

Set a provider API key before launching:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
aos
```

You can also run `/login` and select an API-key provider to store the key in `~/.aos-agent/agent/auth.json`.

See [Providers](providers.md) for supported providers, environment variables, and cloud-provider setup.

## First session

Once AOS Agent starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

The default built-in tools are:

- `read` — read files
- `write` — create or overwrite files
- `edit` — patch files
- `bash` — run shell commands

Additional read-only tools (`grep`, `find`, `ls`) are available through tool options. AOS Agent runs in the current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Project instructions

AOS Agent loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project. Use `aos --offline --no-extensions --help` for a safe local startup check that does not contact model, update, package, or telemetry services.

For extension, package, settings, and SDK details, continue with the linked reference pages.
