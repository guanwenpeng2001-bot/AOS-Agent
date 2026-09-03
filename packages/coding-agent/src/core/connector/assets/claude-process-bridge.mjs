import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_STDOUT_QUEUE_BYTES = 256 * 1024;
const MAX_STDOUT_TOTAL_BYTES = 4 * 1024 * 1024;
let child;
let stdoutBytes = 0;
let queuedBytes = 0;
let awaitingStdoutAck = false;
let terminalMessage;
let failed = false;
const stdoutQueue = [];

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function failStdoutLimit() {
	if (failed) return;
	failed = true;
	stdoutQueue.length = 0;
	queuedBytes = 0;
	child?.stdout.pause();
	child?.kill("SIGKILL");
	send({ type: "error", code: "stdout_limit_exceeded" });
}

function flushStdout() {
	if (failed || awaitingStdoutAck) return;
	const bytes = stdoutQueue[0];
	if (bytes !== undefined) {
		awaitingStdoutAck = true;
		send({ type: "stdout", data: bytes.toString("base64") });
		return;
	}
	if (terminalMessage !== undefined) {
		const message = terminalMessage;
		terminalMessage = undefined;
		send(message);
		return;
	}
	child?.stdout.resume();
}

function enqueueStdout(chunk) {
	const bytes = Buffer.from(chunk);
	stdoutBytes += bytes.byteLength;
	if (stdoutBytes > MAX_STDOUT_TOTAL_BYTES) {
		failStdoutLimit();
		return;
	}
	child.stdout.pause();
	for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
		const part = bytes.subarray(offset, offset + MAX_CHUNK_BYTES);
		queuedBytes += part.byteLength;
		if (queuedBytes > MAX_STDOUT_QUEUE_BYTES) {
			failStdoutLimit();
			return;
		}
		stdoutQueue.push(part);
	}
	flushStdout();
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.exit(70);
	}
	if (failed) return;
	if (message.type === "launch") {
		if (child !== undefined) process.exit(71);
		child = spawn(message.command, message.args, {
			cwd: message.cwd,
			env: message.env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", enqueueStdout);
		let stderrBytes = 0;
		child.stderr.on("data", (chunk) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > 256 * 1024) child.kill("SIGKILL");
		});
		child.once("error", () => {
			if (failed) return;
			failed = true;
			send({ type: "error" });
		});
		child.once("close", (code, signal) => {
			if (failed) return;
			terminalMessage = { type: "exit", code, signal };
			flushStdout();
		});
		return;
	}
	if (child === undefined) process.exit(72);
	if (message.type === "stdin" && typeof message.data === "string") {
		child.stdin.write(Buffer.from(message.data, "base64"));
	} else if (message.type === "stdin_end") {
		child.stdin.end();
	} else if (message.type === "stdout_ack" && awaitingStdoutAck) {
		const bytes = stdoutQueue.shift();
		if (bytes === undefined) process.exit(73);
		queuedBytes -= bytes.byteLength;
		awaitingStdoutAck = false;
		flushStdout();
	} else if (message.type === "kill" && typeof message.signal === "string") {
		child.kill(message.signal);
	} else {
		process.exit(73);
	}
});
