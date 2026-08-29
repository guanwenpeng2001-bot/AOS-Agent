import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
	readonly name: string;
	readonly exports: Readonly<Record<string, string | { readonly import?: string; readonly types?: string }>>;
}

export interface PublicRoot {
	readonly packageName: string;
	readonly specifier: string;
	readonly source: string;
}

const PUBLIC_PACKAGE_DIRECTORIES = Object.freeze(["packages/agent", "packages/coding-agent"]);

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function sourceForExport(root: string, packageDirectory: string, target: PackageManifest["exports"][string]): string | undefined {
	const publishedPath = typeof target === "string" ? target : target.types ?? target.import;
	if (publishedPath === undefined || !publishedPath.startsWith("./dist/")) return undefined;
	const sourcePath = join(
		packageDirectory,
		"src",
		publishedPath.slice("./dist/".length).replace(/(?:\.d\.ts|\.js)$/u, ".ts"),
	);
	if (!existsSync(resolve(root, sourcePath))) throw new Error(`Missing public entrypoint source ${sourcePath}`);
	return relative(root, resolve(root, sourcePath)).replaceAll("\\", "/");
}

function discoverPublicRoots(): readonly PublicRoot[] {
	const root = repoRoot();
	const publicRoots: PublicRoot[] = [];
	for (const packageDirectory of PUBLIC_PACKAGE_DIRECTORIES) {
		const manifestPath = resolve(root, packageDirectory, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
		for (const [specifier, target] of Object.entries(manifest.exports)) {
			const source = sourceForExport(root, packageDirectory, target);
			if (source !== undefined) publicRoots.push({ packageName: manifest.name, specifier, source });
		}
	}
	return publicRoots;
}

export const PUBLIC_ROOTS = Object.freeze(discoverPublicRoots());
