const handles = new Map();

const write = (frame) => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const response = (frame, result) => {
	write({
		schemaVersion: 1,
		type: "response",
		requestId: frame.requestId,
		operation: frame.operation,
		supervisorRef: frame.supervisorRef,
		operationNonce: frame.operationNonce,
		result,
	});
};

const handleFor = (frame, payload) => {
	const attemptId = payload?.attempt?.attemptId ?? "unknown_attempt";
	const handle = {
		externalSessionId: `jsonl_session_${attemptId}`,
		externalTurnId: `jsonl_turn_${attemptId}`,
		supervisorRef: frame.supervisorRef,
		operationNonce: frame.operationNonce,
	};
	handles.set(handle.externalSessionId, handle);
	return handle;
};

const terminalFor = (handle, status = "succeeded") => ({
	externalSessionId: handle.externalSessionId,
	externalTurnId: handle.externalTurnId,
	operationNonce: handle.operationNonce,
	status,
	artifacts: [],
	sideEffectState: "none",
	producedAt: new Date().toISOString(),
});

const onFrame = (frame) => {
	if (frame.type === "handshake") {
		write({
			schemaVersion: 1,
			type: "handshake_result",
			requestId: frame.requestId,
			supervisorRef: frame.supervisorRef,
			operationNonce: frame.operationNonce,
			protocolVersion: 1,
			providerId: frame.providerId,
			version: frame.version,
			capability: frame.capability,
			implementedOperations: [
				"spawn",
				"events",
				"connect",
				"lookup",
				"read",
				"write",
				"heartbeat",
				"cancel",
				"dispose",
				...(frame.capability.toolGateway ? ["tool_gateway_request", "tool_gateway_result"] : []),
			],
		});
		return;
	}
	if (frame.type !== "request") return;
	if (frame.operation === "spawn") {
		response(frame, handleFor(frame, frame.payload));
		return;
	}
	if (frame.operation === "events") {
		const handle = frame.payload;
		write({
			schemaVersion: 1,
			type: "event",
			streamId: frame.requestId,
			supervisorRef: frame.supervisorRef,
			operationNonce: frame.operationNonce,
			event: {
				schemaVersion: 1,
				type: "started",
				externalSessionId: handle.externalSessionId,
				externalTurnId: handle.externalTurnId,
				producedAt: new Date().toISOString(),
			},
		});
		write({
			schemaVersion: 1,
			type: "events_end",
			streamId: frame.requestId,
			supervisorRef: frame.supervisorRef,
			operationNonce: frame.operationNonce,
		});
		return;
	}
	if (frame.operation === "read") {
		response(frame, terminalFor(frame.payload));
		return;
	}
	if (frame.operation === "cancel") {
		response(frame, terminalFor(frame.payload, "cancelled"));
		return;
	}
	if (frame.operation === "connect") {
		const handle = handles.get(frame.payload.externalSessionId) ?? {
			externalSessionId: frame.payload.externalSessionId,
			...(frame.payload.externalTurnId === undefined ? {} : { externalTurnId: frame.payload.externalTurnId }),
			supervisorRef: frame.supervisorRef,
			operationNonce: frame.operationNonce,
		};
		response(frame, handle);
		return;
	}
	if (frame.operation === "lookup") {
		response(frame, { status: "missing" });
		return;
	}
	if (frame.operation === "dispose") {
		response(frame, { ok: true });
		return;
	}
	response(frame, { ok: true });
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	for (;;) {
		const newline = input.indexOf("\n");
		if (newline < 0) return;
		const line = input.slice(0, newline);
		input = input.slice(newline + 1);
		try {
			onFrame(JSON.parse(line));
		} catch {
			process.exitCode = 70;
			process.stdin.destroy();
			return;
		}
	}
});
