/**
 * Session Management
 *
 * Control session persistence: in-memory, new file, continue, or open specific.
 */

import { createAgentSession, listSessions } from "aos-agent";

// In-memory (no persistence)
const { session: inMemory } = await createAgentSession({
	session: { mode: "memory" },
});
console.log("In-memory session:", inMemory.sessionFile ?? "(none)");
inMemory.dispose();

// New persistent session
const { session: newSession } = await createAgentSession({
	session: { mode: "new" },
});
console.log("New session file:", newSession.sessionFile);
newSession.dispose();

// Continue most recent session (or create new if none)
const { session: continued, modelFallbackMessage } = await createAgentSession({
	session: { mode: "continue" },
});
if (modelFallbackMessage) console.log("Note:", modelFallbackMessage);
console.log("Continued session:", continued.sessionFile);
continued.dispose();

// List and open specific session
const sessions = await listSessions(process.cwd());
console.log(`\nFound ${sessions.length} sessions:`);
for (const info of sessions.slice(0, 3)) {
	console.log(`  ${info.id.slice(0, 8)}... - "${info.firstMessage.slice(0, 30)}..."`);
}

if (sessions.length > 0) {
	const { session: opened } = await createAgentSession({
		session: { mode: "open", path: sessions[0].path },
	});
	console.log(`\nOpened: ${opened.sessionId}`);
	opened.dispose();
}

// Custom session directory (no cwd encoding)
// const customDir = "/path/to/my-sessions";
// const { session } = await createAgentSession({
//   session: { mode: "new", directory: customDir },
// });
// listSessions(process.cwd(), customDir);
