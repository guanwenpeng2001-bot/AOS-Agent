# Security

AOS Agent is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether AOS Agent loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

AOS Agent considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.aos-agent/settings.json`
- `.aos-agent/extensions`, `.aos-agent/skills`, `.aos-agent/prompts`, or `.aos-agent/themes`
- `.aos-agent/SYSTEM.md` or `.aos-agent/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.aos-agent` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, AOS Agent follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.aos-agent/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows AOS Agent to load project resources that require trust, including:

- `.aos-agent/settings.json`
- `.aos-agent` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, AOS Agent only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

AOS Agent does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the AOS Agent process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. AOS Agent is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing AOS Agent's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by AOS Agent.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run AOS Agent in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `aos` process inside a container/sandbox
- run host AOS Agent while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.aos-agent/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## MCP servers, OAuth, and remote content

MCP servers are governed by the capability registry, execution policy, and project trust (see [Capabilities and MCP](capabilities.md)). A configured server is never connected automatically; only servers selected by the frozen capability binding connect, and only for tool discovery and calls.

### Transport and authentication

- **stdio** servers run as local child processes. They never participate in OAuth. Only environment variable names listed in the config are passed through, under execution-policy authorization; the process environment is never inherited wholesale.
- **Streamable HTTP** servers can use OAuth 2.0 (Authorization Code + PKCE). Authorization is an explicit user action (`/mcp auth <server-id>`): confirm before any redirect, the authorization URL is shown in the interactive dialog, and the callback is a loopback listener or a manual code. Tokens are stored only in the MCP credential namespace (`mcp__<installationId>__<serverIdentity>`) in the session's agent directory, bound to the canonical server URL, issuer, and scope. Tokens are never displayed, logged, or returned by any public surface. `/mcp logout <server-id>` deletes the local credential after a best-effort RFC 7009 revocation; revocation failure never blocks local cleanup.

### Remote content is untrusted

Resources and prompts are never loaded automatically and are never injected into the system or developer prompt. Access is explicit and confirm-gated:

- `/mcp resources` and `/mcp prompts` list catalog metadata only.
- `/mcp resource <server-id> <resourceId>` and `/mcp prompt <server-id> <promptId> [key=value ...]` read or get one listed item by its digest id, show a redacted digest receipt, and only then ask for confirmation before attaching it to the session.
- Attaching is the only way remote content enters the session. Attachments carry an untrusted provenance wrapper, digest/size metadata, and only allowlisted text/image blocks; they are never treated as trusted instructions and never override local prompt templates.

All MCP output is restricted to sanitized digests and metadata labeled untrusted. Raw URIs, prompt names and argument values, tokens, server URLs, and remote original text are never rendered and never retained on receipts. Errors use fixed safe templates or stable codes, so remote error text cannot leak into the TUI, RPC, SDK, or logs. The authorization URL appears only in the interactive `/mcp auth` dialog, which is the user's own authorization step.

Headless modes (print, JSON, RPC, SDK) never auto-approve an OAuth flow or an attach: a pending approval or an unattached resource fails closed with a stable code.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](../../../SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how AOS Agent grants access that the local user did not already have.
