import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_CHUNK_BYTES = 64 * 1024;
let child;

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendBytes(type, chunk) {
	const bytes = Buffer.from(chunk);
	for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
		send({ type, data: bytes.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64") });
	}
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.exit(70);
	}
	if (message.type === "launch") {
		if (child !== undefined) process.exit(71);
		child = spawn(message.command, message.args, {
			cwd: message.cwd,
			env: message.env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => sendBytes("stdout", chunk));
		let stderrBytes = 0;
		child.stderr.on("data", (chunk) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > 256 * 1024) child.kill("SIGKILL");
		});
		child.once("error", () => send({ type: "error" }));
		child.once("exit", (code, signal) => send({ type: "exit", code, signal }));
		return;
	}
	if (child === undefined) process.exit(72);
	if (message.type === "stdin" && typeof message.data === "string") {
		child.stdin.write(Buffer.from(message.data, "base64"));
	} else if (message.type === "stdin_end") {
		child.stdin.end();
	} else if (message.type === "kill" && typeof message.signal === "string") {
		child.kill(message.signal);
	} else {
		process.exit(73);
	}
});
