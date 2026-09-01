const WINDOWS_LONG_PATH_THRESHOLD = 260;
const WINDOWS_EXTENDED_PATH_PREFIX = "\\\\?\\";

/**
 * Return a Windows path that can be passed as a process working directory
 * without the legacy MAX_PATH limit.
 */
export function toWindowsExtendedPath(path: string): string {
	if (path.startsWith(WINDOWS_EXTENDED_PATH_PREFIX)) return path;
	if (path.startsWith("\\\\")) return `${WINDOWS_EXTENDED_PATH_PREFIX}UNC\\${path.slice(2)}`;
	return `${WINDOWS_EXTENDED_PATH_PREFIX}${path}`;
}

export function normalizeLauncherWorkingDirectory(cwd: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32" || cwd.length < WINDOWS_LONG_PATH_THRESHOLD) return cwd;
	return toWindowsExtendedPath(cwd);
}
