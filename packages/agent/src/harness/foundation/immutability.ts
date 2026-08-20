/** Clone JSON-shaped contract values and recursively freeze the clone. */
export function cloneDeepFrozen<T>(value: T): T {
	const clone = cloneJson(value);
	return freezeDeep(clone);
}
function cloneJson<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	const source = value as Record<string, unknown>;
	const copy: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(source)) copy[key] = cloneJson(child);
	return copy as T;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
		Object.freeze(value);
	}
	return value;
}
