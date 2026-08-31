# Environment variables

AOS Agent uses environment variables for process configuration, provider credentials, and session metadata passed to commands run by the built-in bash tool.

## Process marker

The CLI and RPC entry points set `AOS_AGENT=true`. Child processes inherit it and can use it to detect that they run inside AOS Agent. The previous `AOS_AGENT_CODING_AGENT` name is no longer written.

`AI_AGENT` is also set to `aos-agent` by the CLI and RPC entry points. This is an interoperability marker for terminals and wrappers that detect the active agent; child processes inherit it. There are no in-repository readers, but the variable is intentionally retained for external tooling and is not a product configuration or credential variable.

## AOS Agent configuration

These are the product-specific variables:

| Variable | Description |
|----------|-------------|
| `AOS_AGENT_DIR` | Override the config directory; default is `~/.aos-agent/agent`. `AOS_AGENT_CODING_AGENT_DIR` remains a deprecated read alias for one release. |
| `AOS_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir`. `AOS_AGENT_CODING_AGENT_SESSION_DIR` remains a deprecated read alias for one release. |
| `AOS_AGENT_PACKAGE_DIR` | Override the installed package directory, useful for Nix/Guix store paths |
| `AOS_AGENT_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
| `AOS_AGENT_SKIP_VERSION_CHECK` | Disable version-check network requests when a checker is configured |
| `AOS_AGENT_TELEMETRY` | Override install/update telemetry: `1`/`true`/`yes` or `0`/`false`/`no` |
| `AOS_AGENT_SHARE_VIEWER_URL` | Override the base URL used by `/share` when a share viewer is configured |
| `AOS_AGENT_EXPERIMENTAL` | Enable experimental first-time setup features when set to `1` |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).

## External OAuth dependency

The Radius OAuth client currently uses the legacy `pi-gateway` client ID because the gateway has not issued an AOS client ID. This is an intentional, pending external dependency; keep the value until the gateway publishes and registers its replacement, then update the client and gateway together.

## Bash-tool session metadata

Commands run by the bash tool receive current session state through these variables:

| Variable | Description |
|----------|-------------|
| `AOS_AGENT_SESSION_ID` | Current session ID |
| `AOS_AGENT_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `AOS_AGENT_PROVIDER` | Currently selected model provider |
| `AOS_AGENT_MODEL` | Currently selected model ID |
| `AOS_AGENT_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts, so switching models or changing the reasoning level affects the next bash command without restarting AOS Agent.
