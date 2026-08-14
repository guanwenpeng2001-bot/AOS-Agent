import { dirname } from "node:path";
import { SessionManager } from "../../src/core/session-manager.ts";

const [sessionFile, marker, countValue] = process.argv.slice(2);
const count = Number(countValue);

if (!sessionFile || !marker || !Number.isInteger(count) || count < 1) {
	throw new Error("Expected session file, marker, and positive count");
}

const session = SessionManager.open(sessionFile, dirname(sessionFile));
for (let index = 0; index < count; index++) {
	session.appendCustomEntry("session-write-worker", { marker, index });
}
