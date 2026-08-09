export function getAosUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `aos-agent/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
