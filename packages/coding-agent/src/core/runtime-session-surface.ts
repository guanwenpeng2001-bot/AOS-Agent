import type { AgentSession, PromptOptions } from "./session/agent-session.ts";

export const RUNTIME_SESSION_SURFACES = [
	"tui",
	"print",
	"headless",
	"rpc",
	"sdk",
	"automation_host",
] as const;

export type RuntimeSessionSurface = (typeof RUNTIME_SESSION_SURFACES)[number];

export interface RuntimeSessionSurfaceAdapter {
	readonly surface: RuntimeSessionSurface;
	readonly session: AgentSession;
	prompt(prompt: string, options?: PromptOptions): Promise<void>;
}

export function isRuntimeSessionSurface(value: unknown): value is RuntimeSessionSurface {
	return typeof value === "string" && RUNTIME_SESSION_SURFACES.some((surface) => surface === value);
}

/**
 * Bind one public entry surface to the canonical AgentSession.
 *
 * The adapter owns no queue, transcript, lifecycle, or execution state. It
 * delegates every prompt to the supplied AgentSession and adds only durable
 * ingress provenance.
 */
export function createRuntimeSessionSurfaceAdapter(
	session: AgentSession,
	surface: RuntimeSessionSurface,
): RuntimeSessionSurfaceAdapter {
	return {
		surface,
		session,
		prompt: (prompt, options) => session.prompt(prompt, { ...options, surface }),
	};
}
