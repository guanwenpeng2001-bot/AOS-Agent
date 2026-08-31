import { readFile, writeFile } from "node:fs/promises";

const statePath = process.env.FAKE_CURSOR_AGENT_STATE_FILE;
let state = process.env.FAKE_CURSOR_AGENT_STATE ?? "normal";
if (statePath) {
	try {
		state = (await readFile(statePath, "utf8")).trim() || state;
	} catch {
		// The caller may intentionally start without a state file.
	}
}

const [command] = process.argv.slice(2);

if (state === "timeout") {
	await new Promise((resolve) => setTimeout(resolve, 10_000));
}

if (command === "status") {
	const authenticated = state !== "not_logged_in";
	process.stdout.write(
		JSON.stringify({
			status: authenticated ? "authenticated" : "unauthenticated",
			isAuthenticated: authenticated,
			hasAccessToken: authenticated,
			hasRefreshToken: authenticated,
			userInfo: authenticated ? { email: "fixture@example.com", userId: "fixture-user" } : undefined,
		}),
	);
	process.exit(0);
}

if (command === "login") {
	if (statePath) await writeFile(statePath, "normal", "utf8");
	process.exit(0);
}

if (command === "logout") {
	if (statePath) await writeFile(statePath, "not_logged_in", "utf8");
	process.exit(0);
}

if (command === "models") {
	if (state === "not_logged_in") {
		process.stderr.write("Not authenticated. Run cursor-agent login.\n");
		process.exit(1);
	}
	if (state === "empty_models") {
		process.stdout.write("Available models\n\nTip: use --model <id> to switch.\n");
		process.exit(0);
	}
	process.stdout.write(
		"Available models\n\nauto - Auto (default)\ngpt-5.2 - GPT-5.2\n\nTip: use --model <id> to switch.\n",
	);
	process.exit(0);
}

process.stderr.write(`Unsupported fixture command: ${command ?? "<missing>"}\n`);
process.exit(2);
