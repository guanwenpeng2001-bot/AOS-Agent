import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(".");
const markdownRoots = [
	"README.md",
	"CONTRIBUTING.md",
	"DEVELOPMENT.md",
	"packages/coding-agent/README.md",
	"packages/coding-agent/docs",
	"packages/coding-agent/examples",
];
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const markdownFiles = [];

function collectMarkdownFiles(path) {
	const absolutePath = resolve(repositoryRoot, path);
	const stats = statSync(absolutePath);
	if (stats.isFile()) {
		if (absolutePath.endsWith(".md")) markdownFiles.push(absolutePath);
		return;
	}

	for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
		if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
			collectMarkdownFiles(join(absolutePath, entry.name));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			markdownFiles.push(join(absolutePath, entry.name));
		}
	}
}

for (const path of markdownRoots) collectMarkdownFiles(path);

function formatPath(path) {
	return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function markdownLinks(source) {
	const links = [];
	const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
	let fence;

	for (const [lineNumber, line] of source.split("\n").entries()) {
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!fence) {
				fence = { character: marker[0], length: marker.length };
			} else if (marker[0] === fence.character && marker.length >= fence.length) {
				fence = undefined;
			}
			continue;
		}

		if (fence) continue;
		for (const match of line.matchAll(pattern)) {
			let destination = match[1].trim();
			if (destination.startsWith("<")) {
				const end = destination.indexOf(">");
				if (end === -1) continue;
				destination = destination.slice(1, end);
			} else {
				destination = destination.split(/\s+/u, 1)[0] ?? "";
			}

			links.push({ destination, line: lineNumber + 1 });
		}
	}

	return links;
}

function isExternalDestination(destination) {
	return destination.startsWith("#") || destination.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(destination);
}

function destinationPath(destination) {
	const pathEnd = destination.search(/[?#]/u);
	return pathEnd === -1 ? destination : destination.slice(0, pathEnd);
}

function resolveRelativeTarget(sourcePath, destination) {
	const path = destinationPath(destination);
	if (!path) return undefined;

	try {
		return resolve(dirname(sourcePath), decodeURIComponent(path));
	} catch {
		return undefined;
	}
}

const failures = [];
for (const sourcePath of markdownFiles.sort()) {
	const source = readFileSync(sourcePath, "utf8");
	for (const { destination, line } of markdownLinks(source)) {
		if (!destination || isExternalDestination(destination)) continue;

		const targetPath = resolveRelativeTarget(sourcePath, destination);
		if (!targetPath || !existsSync(targetPath)) {
			failures.push(`${formatPath(sourcePath)}:${line}: ${destination}`);
		}
	}
}

const docsJsonPath = resolve(repositoryRoot, "packages/coding-agent/docs/docs.json");
const docsJson = JSON.parse(readFileSync(docsJsonPath, "utf8"));
const docsDirectory = dirname(docsJsonPath);
const docsJsonPaths = [];

function collectDocsJsonPaths(items) {
	for (const item of items ?? []) {
		if (typeof item.path === "string") docsJsonPaths.push(item.path);
		if (Array.isArray(item.items)) collectDocsJsonPaths(item.items);
	}
}

collectDocsJsonPaths(docsJson.navigation);
for (const redirect of docsJson.redirects ?? []) {
	if (typeof redirect.to === "string") docsJsonPaths.push(redirect.to);
}

for (const path of docsJsonPaths) {
	const targetPath = resolve(docsDirectory, path);
	if (!existsSync(targetPath)) {
		failures.push(`packages/coding-agent/docs/docs.json: ${path}`);
	}
}

if (failures.length > 0) {
	console.error("Missing relative documentation link targets:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`Checked ${markdownFiles.length} Markdown files and ${docsJsonPaths.length} docs.json paths.`);
