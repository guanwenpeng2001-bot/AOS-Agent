import type { JsonValue, ProtocolError, ProtocolErrorCode } from "@aos-agent/protocol";

export class AosServerError extends Error {
	readonly code: ProtocolErrorCode;
	readonly details: JsonValue | undefined;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "AosServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

export class PiDisconnectedError extends Error {
	constructor(message = "aos CLIent is disconnected") {
		super(message);
		this.name = "PiDisconnectedError";
	}
}

export class AosClientDisposedError extends Error {
	constructor() {
		super("aos CLIent is disposed");
		this.name = "AosClientDisposedError";
	}
}

export class AosSessionOwnershipError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "AosSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

export class AosSessionDetachedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "AosSessionDetachedError";
		this.sessionId = sessionId;
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): PiDisconnectedError {
	const cause = toError(error);
	return cause instanceof PiDisconnectedError ? cause : new PiDisconnectedError(cause.message);
}
