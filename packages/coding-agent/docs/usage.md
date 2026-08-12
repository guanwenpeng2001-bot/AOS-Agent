# Using AOS Agent

This page collects day-to-day usage details that do not fit on the quickstart page.

Use the installed `aos` executable and the AOS defaults documented in [Quickstart](quickstart.md).

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model. Totals include assistant responses, usage reported by tools, and summary generation.

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Copy response | Ctrl+X copies the last assistant message; in `/tree`, it copies the selected message |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| [`/llama`](llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Switch models |
| `/model-routes` | List the redacted ModelBroker route and role catalog |
| `/model-route <route\|role:name>` | Select a declared ModelBroker route or role |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | AOS Agentck from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/capabilities` | List the redacted capability catalog, inspect a descriptor, or approve an ask capability for this session |
| `/quit` | Quit AOS Agent |

## Capabilities

AOS Agent models what it can load and call — built-in tools, extension tools, SDK tools, skills, extensions, and MCP servers — as capabilities. Each capability has a stable id, a kind, a redacted source, an availability, a trust flag, and a profile decision (`allow`, `ask`, or `deny`).

In interactive mode, inspect and approve capabilities from the current session:

| Command | Effect |
|---------|--------|
| `/capabilities` | List the redacted capability catalog: decision, kind, availability, name, source, revision, and selected status |
| `/capabilities inspect <id>` | Show one descriptor: kind, profile rule, availability, trust, binding/selected status, redacted source, and revision |
| `/capabilities approve <id>` | Approve an ask capability for this session only |

These commands are backed by the public Session surface (`inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, and `approveCapability()`). The catalog view is redacted: command arguments, environment/header values, tokens, and unredacted URLs never appear, and raw local paths are not printed. Only `CapabilityError` codes and their redacted messages are shown for failures.

Approvals are session-local and never written to settings; a denied, untrusted, or unavailable capability can never be approved. The active profile remains the authority over what enters the binding.

Capability trust: project-scoped sources default to untrusted and are force-denied. MCP servers connect over stdio or Streamable HTTP; a server that cannot connect is reported as unavailable/degraded rather than exposing connection internals.

Capability v1 covers built-in tools, extension tools, SDK tools, skills, extensions, and MCP server tools over stdio or Streamable HTTP. It does not include OAuth for MCP servers, MCP resources or prompts, the Sandbox, external Agent orchestration, or legacy SSE transports. ModelBroker route selection is documented separately in [Models](models.md).

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want AOS Agent to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.aos-agent/agent/sessions/`, organized by working directory.

```bash
aos -c                  # Continue most recent session
aos -r                  # Browse and select a session
aos --no-session        # Ephemeral mode; do not save
aos --name "my task"    # Set session display name at startup
aos --session <path|id> # Use a specific session file or session ID
aos --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

AOS Agent loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.aos-agent/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

If a directory contains `AGENTS.override.md`, AOS Agent loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories still layer normally.

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.aos-agent/SYSTEM.md` for a project
- `~/.aos-agent/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, AOS Agent asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.aos-agent/agent/trust.json`. Trusting a project allows AOS Agent to load `.aos-agent/settings.json` and `.aos-agent` resources, install missing project packages, and execute project extensions.

Before the trust decision, AOS Agent loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.aos-agent/agent/settings.json`, or change it with `/settings`.

`aos config` and package commands use the same project trust flow, except `aos update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.aos-agent/agent/trust.json` only; the current session is not reloaded, so restart AOS Agent for changes to take effect.


## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

If you use AOS Agent for open source work and want to publish sessions for model, prompt, tool, and evaluation research, see [`aos-agent-share-hf`](UPSTREAM.md). It publishes sessions to Hugging Face datasets.

## CLI Reference

```bash
aos [options] [@files...] [messages...]
```

### Package Commands

```bash
aos install <source> [-l]     # Install package, -l for project-local
aos remove <source> [-l]      # Remove package
aos uninstall <source> [-l]   # Alias for remove
aos update [source|self|aos]   # Update aos only, or one package source
aos update --all              # Update aos and packages; reconcile pinned git refs
aos update --extensions       # Update packages only; reconcile pinned git refs
aos update --models           # Refresh model catalogs only
aos update --self             # Update aos only
aos update --extension <src>  # Update one package
aos list                      # List installed packages
aos config                    # Enable/disable package resources
```

These commands manage aos-agent packages and `aos update` can update the aos CLI installation. To uninstall aos itself, see [Quickstart](quickstart.md#uninstall). `aos config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `aos update` never prompts for project trust.

See [AOS Agent Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, AOS Agent also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | aos -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--model-route <id>` | Select a declared ModelBroker route |
| `--model-role <id>` | Select a declared ModelBroker role |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
aos --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

In `fullscreen` mode, the transcript scrolls inside the terminal viewport while queued messages, working status, extension widgets, editor, and footer remain fixed at the bottom. Mouse/trackpad input scrolls the region under the pointer; keyboard viewport actions always remain available. Inline images work in terminals that support the Kitty graphics protocol, including Kitty and Ghostty. In iTerm2 they render as text placeholders because its inline-image protocol cannot delete or crop placements during application-owned scrolling. In `regular` mode, AOS Agent uses the main screen and terminal-owned scrollback, and iTerm2 inline images continue to render normally.

Set **TUI mode** in `/settings` to switch between `regular` and `fullscreen` immediately and choose the default for future sessions. **Fullscreen exit output** controls whether exiting fullscreen prints the final transcript or restores the previous screen and prints only the session resume hint.

### File Arguments

Prefix files with `@` to include them in the message:

```bash
aos @prompt.md "Answer this"
aos -p @screenshot.png "What's in this image?"
aos @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
aos "List all .ts files in src/"

# Non-interactive
aos -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | aos -p "Summarize this text"

# Named one-shot session
aos --name "release audit" -p "Audit this repository"

# Different model
aos --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
aos --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
aos --model sonnet:high "Solve this complex problem"

# Limit model cycling
aos --models "claude-*,gpt-4o"

# Read-only mode
aos --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
aos --exclude-tools ask_question
```

## Design Principles

AOS Agent keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages, or use external tools such as containers and tmux.

For implementation background and source history, see the [upstream provenance record](../../UPSTREAM.md).
