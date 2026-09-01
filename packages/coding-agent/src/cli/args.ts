/**
 * CLI argument parsing and help display
 */

import { type ThinkingLevel, validateEndpointSecurity } from "@aos-agent/agent-core";
import chalk from "chalk";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import type { TuiMode } from "../core/runtime/settings-manager.ts";
import {
	parseRpcTransportAddress,
	type RpcTransportAddress,
	validateRpcTransportAddress,
} from "../modes/rpc/rpc-transport-address.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	modelRoute?: string;
	modelRole?: string;
	policyProfile?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	rpcListen?: RpcTransportAddress;
	rpcAuth?: "bearer" | "mtls";
	rpcBearerToken?: string;
	rpcTlsCert?: string;
	rpcTlsKey?: string;
	rpcTlsClientCa?: string;
	rpcTlsMinVersion?: "1.2" | "1.3";
	rpcAllowRemote?: boolean;
	name?: string;
	fromPr?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--rpc-listen") {
			if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--rpc-listen requires a value" });
			} else {
				const value = args[++i]!;
				const parsedAddress = parseRpcTransportAddress(value);
				if ("address" in parsedAddress) {
					result.rpcListen = parsedAddress.address;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid --rpc-listen address: ${parsedAddress.error.message}`,
					});
				}
			}
		} else if (arg === "--rpc-auth") {
			const scheme = args[i + 1];
			if (scheme === "bearer" || scheme === "mtls") {
				result.rpcAuth = scheme;
				i++;
			} else {
				if (scheme !== undefined && !scheme.startsWith("-")) i++;
				result.diagnostics.push({ type: "error", message: "--rpc-auth requires bearer or mtls" });
			}
		} else if (arg === "--rpc-bearer-token") {
			if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--rpc-bearer-token requires a value" });
			} else {
				result.rpcBearerToken = args[++i]!;
			}
		} else if (arg === "--rpc-tls-cert") {
			if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--rpc-tls-cert requires a path" });
			} else {
				result.rpcTlsCert = args[++i]!;
			}
		} else if (arg === "--rpc-tls-key") {
			if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--rpc-tls-key requires a path" });
			} else {
				result.rpcTlsKey = args[++i]!;
			}
		} else if (arg === "--rpc-tls-client-ca") {
			if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--rpc-tls-client-ca requires a path" });
			} else {
				result.rpcTlsClientCa = args[++i]!;
			}
		} else if (arg === "--rpc-tls-min-version") {
			const version = args[i + 1];
			if (version === "1.2" || version === "1.3") {
				result.rpcTlsMinVersion = version;
				i++;
			} else {
				if (version !== undefined && !version.startsWith("-")) i++;
				result.diagnostics.push({ type: "error", message: "--rpc-tls-min-version requires 1.2 or 1.3" });
			}
		} else if (arg === "--rpc-allow-remote") {
			result.rpcAllowRemote = true;
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--model-route") {
			if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
				result.modelRoute = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--model-route requires a value" });
			}
		} else if (arg === "--model-role") {
			if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
				result.modelRole = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--model-role requires a value" });
			}
		} else if (arg === "--policy") {
			if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
				result.policyProfile = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--policy requires a value" });
			}
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
		} else if (arg === "--from-pr") {
			if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
				result.fromPr = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--from-pr requires a value" });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-id" && i + 1 < args.length) {
			result.sessionId = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			result.excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--tui-mode") {
			const mode = args[i + 1];
			if (mode === "regular" || mode === "fullscreen") {
				result.tuiMode = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
				});
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	if (result.modelRoute !== undefined && result.modelRole !== undefined) {
		result.diagnostics.push({ type: "error", message: "--model-route and --model-role are mutually exclusive" });
	}
	if (result.rpcListen !== undefined && result.mode !== "rpc") {
		result.diagnostics.push({ type: "error", message: "--rpc-listen requires --mode rpc" });
		result.rpcListen = undefined;
	}
	finalizeRpcListener(result);

	return result;
}

function finalizeRpcListener(result: Args): void {
	const hasSecurityFlags =
		result.rpcAuth !== undefined ||
		result.rpcBearerToken !== undefined ||
		result.rpcTlsCert !== undefined ||
		result.rpcTlsKey !== undefined ||
		result.rpcTlsClientCa !== undefined ||
		result.rpcTlsMinVersion !== undefined ||
		result.rpcAllowRemote === true;
	if (result.rpcListen === undefined) {
		if (hasSecurityFlags) {
			result.diagnostics.push({ type: "error", message: "RPC security flags require --rpc-listen" });
		}
		return;
	}

	const authScheme =
		result.rpcAuth ??
		(result.rpcBearerToken !== undefined ? "bearer" : result.rpcTlsClientCa !== undefined ? "mtls" : "none");
	let invalid = false;
	if (authScheme === "bearer" && !result.rpcBearerToken) {
		result.diagnostics.push({ type: "error", message: "RPC bearer authentication requires --rpc-bearer-token" });
		invalid = true;
	}
	if (authScheme === "mtls" && !result.rpcTlsClientCa) {
		result.diagnostics.push({ type: "error", message: "RPC mTLS authentication requires --rpc-tls-client-ca" });
		invalid = true;
	}
	if (authScheme === "mtls" && result.rpcBearerToken !== undefined) {
		result.diagnostics.push({ type: "error", message: "--rpc-bearer-token cannot be used with mTLS authentication" });
		invalid = true;
	}

	const tlsEnabled =
		result.rpcListen.tls?.enabled === true ||
		result.rpcTlsCert !== undefined ||
		result.rpcTlsKey !== undefined ||
		result.rpcTlsClientCa !== undefined ||
		authScheme === "mtls";
	if (tlsEnabled && (!result.rpcTlsCert || !result.rpcTlsKey)) {
		result.diagnostics.push({
			type: "error",
			message: "RPC TLS requires both --rpc-tls-cert and --rpc-tls-key",
		});
		invalid = true;
	}

	const address = validateRpcTransportAddress({
		...result.rpcListen,
		...(authScheme === "none"
			? {}
			: {
					auth:
						authScheme === "bearer"
							? { scheme: "bearer", bearerToken: result.rpcBearerToken ?? "invalid" }
							: { scheme: "mtls" as const },
				}),
		...(tlsEnabled
			? {
					tls: {
						enabled: true,
						minVersion: result.rpcTlsMinVersion ?? result.rpcListen.tls?.minVersion ?? "1.2",
						...(result.rpcTlsCert === undefined ? {} : { certRef: result.rpcTlsCert }),
						...(result.rpcTlsKey === undefined ? {} : { keyRef: result.rpcTlsKey }),
						...(result.rpcTlsClientCa === undefined ? {} : { clientCaRef: result.rpcTlsClientCa }),
					},
				}
			: {}),
		...(result.rpcAllowRemote === true ? { allowRemote: true } : {}),
	});
	result.rpcListen = address;
	if (invalid) return;

	const endpoint = validateEndpointSecurity({
		kind: address.transport,
		host: address.host,
		port: address.port,
		auth: { scheme: address.auth?.scheme ?? "none" },
		tls: address.tls,
		allowRemote: address.allowRemote ?? false,
	});
	if (!endpoint.ok) result.diagnostics.push({ type: "error", message: endpoint.error.message });
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_TITLE)} (${APP_NAME}) - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|aos]   Update AOS Agent, extensions, or model catalogs
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config [-l]               Open TUI to enable/disable package resources (Tab switches scope)
  ${APP_NAME} auth <command>            Print credentials or check provider readiness
	${APP_NAME} session <command>         List, archive, or unarchive sessions
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list/config/auth

${chalk.bold("Options:")}
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --model-route <id>             Select a declared ModelBroker route for the session
  --model-role <id>              Select a declared ModelBroker role for the session
  --policy <profile>             Select a named execution policy profile for this run
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --rpc-listen <address>         RPC listener (tcp://, ws://, or wss://<host>:<port>); requires --mode rpc
  --rpc-auth <scheme>            RPC authentication scheme: bearer or mtls
  --rpc-bearer-token <token>     Expected RPC bearer token
  --rpc-tls-cert <path>          RPC TLS server certificate PEM path
  --rpc-tls-key <path>           RPC TLS server private-key PEM path
  --rpc-tls-client-ca <path>     RPC mTLS client CA bundle PEM path
  --rpc-tls-min-version <value>  RPC TLS minimum version: 1.2 (default) or 1.3
  --rpc-allow-remote             Explicitly permit a secured non-loopback RPC listener
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --session-id <id>              Use exact project session ID, creating it if missing
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --from-pr <number|url>         Associate a new session with a pull request
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names to disable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]             List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --tui-mode <mode>              TUI mode: regular (default) or fullscreen
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --offline                      Disable startup network operations (same as AOS_AGENT_OFFLINE=1)
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Print a provider API key for an external client
  ${APP_NAME} auth print-api-key --provider openai

  # Print an OAuth bearer token for an external client (refreshes if expired)
  ${APP_NAME} auth print-bearer-token --provider openai-codex

  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Start a named session
  ${APP_NAME} --name "Refactor auth module"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Disable one tool while keeping the rest available
  ${APP_NAME} --exclude-tools ask_question

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_AUTH_TOKEN             - Anthropic bearer auth token
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  BASETEN_API_KEY                  - Baseten API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  QWEN_TOKEN_PLAN_API_KEY          - Qwen Token Plan API key (international region)
  QWEN_TOKEN_PLAN_CN_API_KEY       - Qwen Token Plan API key (China region)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  AOS_AGENT_PACKAGE_DIR            - Override package directory (for Nix/Guix store paths)
  AOS_AGENT_OFFLINE                - Disable startup network operations when set to 1/true/yes
  AOS_AGENT_TELEMETRY              - Override install telemetry when set to 1/true/yes or 0/false/no
  AOS_AGENT_SHARE_VIEWER_URL       - Base URL for /share command (set explicitly for a share viewer)

${chalk.bold("Built-in Tool Names:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
`);
}
