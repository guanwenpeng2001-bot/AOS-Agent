import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultPublicRoots = [
	"packages/agent/src/index.ts",
	"packages/agent/src/node.ts",
	"packages/agent/src/harness/session/testing/index.ts",
	"packages/coding-agent/src/index.ts",
	"packages/coding-agent/src/client/index.ts",
	"packages/coding-agent/src/rpc-entry.ts",
];
const ignoredDirectories = new Set([".git", ".turbo", "coverage", "dist", "node_modules"]);
const businessVersionPattern = /_?V\d+(?=[A-Z_]|$)/u;
const documentationProductPhrases = new Map([
	["Foundation v1", "Foundation"],
	["Foundation V1", "Foundation"],
	["Context Engine v1", "Context Engine"],
	["Capability Registry/MCP v1", "Capability Registry/MCP"],
	["Execution Policy/Sandbox v1", "Execution Policy/Sandbox"],
	["Execution Audit v1", "Execution Audit"],
	["Task-level Human Gate v1", "Task-level Human Gate"],
	["External Agent Adapter v1", "External Agent Adapter"],
	["MCP OAuth and resources/prompts v1", "MCP OAuth and resources/prompts"],
	["Task Credential / Lease v1", "Task Credential / Lease"],
	["Sandbox Operation Worker v1", "Sandbox Operation Worker"],
	["External Agent Adapter (v1)", "External Agent Adapter"],
	["Execution Audit / Replay / External Mapping Contract (v1)", "Execution Audit / Replay / External Mapping Contract"],
	["Remote-Neutral Operation Contract (v1)", "Remote-Neutral Operation Contract"],
	["Out of scope (v1)", "Current out of scope"],
	["Automation Host v1", "Automation Host"],
	["Capability v1", "Capability layer"],
	["Task Gate is the v1 control-plane contract", "Task Gate is the current control-plane contract"],
	["v1 defines no reason code for `task.gate.cancel`", "the current contract defines no reason code for `task.gate.cancel`"],
	["Task Graph is the v1 control-plane contract", "Task Graph is the current control-plane contract"],
	["Task Graph v1", "Task Graph"],
	["Task Credential / Lease is the v1 control-plane contract", "Task Credential / Lease is the current control-plane contract"],
	["the v1 boundary for the policy and sandbox work", "the current boundary for the policy and sandbox work"],
	["The complete v1 error-code set", "The complete error-code set"],
	["the v1 boundary for the Execution Audit", "the current boundary for the Execution Audit"],
	["outside the additive v1", "outside the current additions"],
	["the v1 boundary for the External Agent Adapter", "the current boundary for the External Agent Adapter"],
	["v1 controlled Runs", "controlled Runs"],
	["v1 ships without one", "the current release ships without one"],
	["The v1 host path", "The current host path"],
	["The v1 host contract", "The current host contract"],
	["Non-goals for v1", "Current non-goals"],
	["in v1;", "in the current release;"],
	["and v1 introduces no", "and this layer introduces no"],
	["and v1 keeps", "and the current release keeps"],
	["In v1, inputs", "Inputs"],
	["the v1 slash-command rule", "the slash-command rule"],
	["freezes the v1 contract", "freezes the current contract"],
	["The v1 schema version is `1`", "The schema version is `1`"],
	["AuditEvent v1", "AuditEvent schema"],
	["the v1 `AuditEventType`", "the current `AuditEventType`"],
	["v1 does not persist", "the current contract does not persist"],
	["v1 does not create", "the current contract does not create"],
	["v1 never reopens", "the current contract never reopens"],
	["v1 never persists", "the current contract never persists"],
	["v1 performs no", "the current contract performs no"],
	["v1 has no", "the current contract has no"],
	["a v1 response", "a response"],
	["(v1: 256 nodes", "(current limits: 256 nodes"],
	["v1 rejects inputs", "the current contract rejects inputs"],
	["v1 does not queue", "the current contract does not queue"],
]);

function argumentValue(name) {
	const prefix = `--${name}=`;
	return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function argumentValues(name) {
	const prefix = `--${name}=`;
	return process.argv.filter((argument) => argument.startsWith(prefix)).map((argument) => argument.slice(prefix.length));
}

const checkOnly = process.argv.includes("--check");
const workspaceRoot = resolve(argumentValue("root") ?? process.cwd());
const mappingPath = resolve(argumentValue("mapping") ?? join(scriptDirectory, "versioned-name-map.json"));
const configuredPublicRoots = argumentValues("public-root");
const publicRootPaths = (configuredPublicRoots.length === 0 ? defaultPublicRoots : configuredPublicRoots).map((path) => resolve(workspaceRoot, path));

function workspacePath(path) {
	return relative(workspaceRoot, path).split(sep).join("/");
}

function loadReviewedMapping() {
	const parsed = JSON.parse(readFileSync(mappingPath, "utf8"));
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error(`Reviewed mapping must be a JSON object: ${mappingPath}`);
	}
	const entries = Object.entries(parsed);
	for (const [oldName, currentName] of entries) {
		if (!businessVersionPattern.test(oldName) || typeof currentName !== "string" || currentName.length === 0 || businessVersionPattern.test(currentName)) {
			throw new Error(`Invalid reviewed mapping: ${oldName} -> ${String(currentName)}`);
		}
	}
	return new Map(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function loadProgram() {
	const configPath = resolve(workspaceRoot, argumentValue("project") ?? "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), { noEmit: true }, configPath);
	if (parsed.errors.length > 0) {
		throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
	}
	return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

const reviewedMapping = loadReviewedMapping();
const program = loadProgram();
const checker = program.getTypeChecker();
const conflicts = [];
const unresolvedReferences = [];
const symbolTargets = new Map();
const removableAliases = new Set();
const publicSymbols = new Set();
const exportsByRoot = new Map();
const reviewedAdditionalBindings = new Map([
	["packages/coding-agent/src/core/worker.ts:WorkerLifecycleStatusV1", "WorkerLifecycleStatus"],
]);

function resolveTypescriptAlias(symbol) {
	return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}

function directAliasTarget(symbol) {
	for (const declaration of symbol.declarations ?? []) {
		if (
			ts.isTypeAliasDeclaration(declaration) &&
			ts.isTypeReferenceNode(declaration.type) &&
			ts.isIdentifier(declaration.type.typeName)
		) {
			const target = checker.getSymbolAtLocation(declaration.type.typeName);
			if (target !== undefined) return resolveTypescriptAlias(target);
		}
		if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && ts.isIdentifier(declaration.initializer)) {
			const target = checker.getSymbolAtLocation(declaration.initializer);
			if (target !== undefined) return resolveTypescriptAlias(target);
		}
		if (ts.isFunctionDeclaration(declaration) && declaration.body?.statements.length === 1) {
			const statement = declaration.body.statements[0];
			if (ts.isReturnStatement(statement) && statement.expression !== undefined && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)) {
				const target = checker.getSymbolAtLocation(statement.expression.expression);
				if (target !== undefined && declaration.name !== undefined && resolveTypescriptAlias(target).name === declaration.name.text.replace(/_?V\d+(?=[A-Z_]|$)/gu, "")) return resolveTypescriptAlias(target);
			}
		}
	}
	return undefined;
}

function publicCanonicalSymbol(input) {
	let current = resolveTypescriptAlias(input);
	const seen = new Set();
	while (!seen.has(current)) {
		seen.add(current);
		const next = directAliasTarget(current);
		if (next === undefined || !publicSymbols.has(next)) return current;
		current = next;
	}
	return current;
}

function assignTarget(symbol, target, reason) {
	const existing = symbolTargets.get(symbol);
	if (existing !== undefined && existing !== target) {
		conflicts.push(`${reason}: ${symbol.name} maps to both ${existing} and ${target}`);
		return;
	}
	symbolTargets.set(symbol, target);
}

function removableDeclaration(symbol) {
	for (const declaration of symbol.declarations ?? []) {
		if (ts.isTypeAliasDeclaration(declaration)) return declaration;
		if (ts.isFunctionDeclaration(declaration)) return declaration;
		if (ts.isVariableDeclaration(declaration)) {
			const statement = declaration.parent.parent;
			if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) return statement;
			conflicts.push(`${workspacePath(declaration.getSourceFile().fileName)}: alias ${symbol.name} shares a variable statement`);
		}
	}
	return undefined;
}

for (const publicRootPath of publicRootPaths) {
	const sourceFile = program.getSourceFile(publicRootPath);
	if (sourceFile === undefined) {
		conflicts.push(`public root is missing from the TypeScript program: ${workspacePath(publicRootPath)}`);
		continue;
	}
	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
	if (moduleSymbol === undefined) {
		conflicts.push(`public root has no module symbol: ${workspacePath(publicRootPath)}`);
		continue;
	}
	const rootExports = new Map();
	for (const exported of checker.getExportsOfModule(moduleSymbol)) {
		rootExports.set(exported.name, exported);
		publicSymbols.add(resolveTypescriptAlias(exported));
		if (businessVersionPattern.test(exported.name) && !reviewedMapping.has(exported.name)) {
			conflicts.push(`${workspacePath(publicRootPath)} exports unreviewed versioned name ${exported.name}`);
		}
	}
	exportsByRoot.set(publicRootPath, rootExports);
}

function mapPublicAliasChain(symbol, target, reason) {
	let current = resolveTypescriptAlias(symbol);
	const seen = new Set();
	while (!seen.has(current)) {
		seen.add(current);
		assignTarget(current, target, reason);
		const next = directAliasTarget(current);
		if (next === undefined || !publicSymbols.has(next)) return current;
		const declaration = removableDeclaration(current);
		if (declaration === undefined) {
			conflicts.push(`${reason}: ${current.name} is a public alias without a removable declaration`);
			return current;
		}
		removableAliases.add(current);
		current = next;
	}
	conflicts.push(`${reason}: alias cycle includes ${current.name}`);
	return current;
}

const activeMappings = [];
for (const [oldName, target] of reviewedMapping) {
	for (const [publicRootPath, rootExports] of exportsByRoot) {
		const exported = rootExports.get(oldName);
		if (exported === undefined) continue;
		const reason = `${workspacePath(publicRootPath)}:${oldName}`;
		const canonical = mapPublicAliasChain(exported, target, reason);
		activeMappings.push({ publicRootPath, oldName, target, canonical });
	}
}

for (const { publicRootPath, oldName, target, canonical } of activeMappings) {
	const targetExport = exportsByRoot.get(publicRootPath)?.get(target);
	if (targetExport === undefined) continue;
	const existing = resolveTypescriptAlias(targetExport);
	if (existing === canonical) continue;
	const existingCanonical = publicCanonicalSymbol(existing);
	if (existingCanonical === canonical) {
		let current = existing;
		while (current !== canonical) {
			assignTarget(current, target, `${workspacePath(publicRootPath)}:${target}`);
			const declaration = removableDeclaration(current);
			const next = directAliasTarget(current);
			if (declaration === undefined || next === undefined) {
				conflicts.push(`${workspacePath(publicRootPath)}:${target} cannot be collapsed to ${target}`);
				break;
			}
			removableAliases.add(current);
			current = next;
		}
		continue;
	}
	if (oldName === "BudgetLedgerV1" || oldName === "MemoryScopeV1") {
		const next = directAliasTarget(existing);
		const declaration = removableDeclaration(existing);
		if (next === undefined || declaration === undefined) {
			conflicts.push(`${workspacePath(publicRootPath)}:${target} is not the reviewed compatibility alias`);
			continue;
		}
		const replacement = symbolTargets.get(publicCanonicalSymbol(next)) ?? publicCanonicalSymbol(next).name.replace(/_?V\d+(?=[A-Z_]|$)/gu, "");
		assignTarget(existing, replacement, `${workspacePath(publicRootPath)}:${target}`);
		removableAliases.add(existing);
		continue;
	}
	conflicts.push(`${workspacePath(publicRootPath)}:${oldName} -> ${target} conflicts with ${existing.name}`);
}

for (const sourceFile of program.getSourceFiles()) {
	const relativeFileName = workspacePath(resolve(sourceFile.fileName));
	function visitAdditionalBinding(node) {
		if (ts.isIdentifier(node)) {
			const target = reviewedAdditionalBindings.get(`${relativeFileName}:${node.text}`);
			if (target !== undefined) {
				const symbol = checker.getSymbolAtLocation(node);
				const hasLocalDeclaration = symbol?.declarations?.some(
					(declaration) =>
						declaration.getSourceFile() === sourceFile &&
						!ts.isImportSpecifier(declaration) &&
						!ts.isImportClause(declaration) &&
						!ts.isNamespaceImport(declaration) &&
						!ts.isExportSpecifier(declaration),
				);
				if (symbol !== undefined && hasLocalDeclaration === true) {
					assignTarget(symbol, target, `${relativeFileName}:${node.text}`);
				}
			}
		}
		ts.forEachChild(node, visitAdditionalBinding);
	}
	visitAdditionalBinding(sourceFile);
}

const renameTexts = new Set(reviewedMapping.keys());
for (const symbol of symbolTargets.keys()) renameTexts.add(symbol.name);

function collectBindingIdentifiers(name, identifiers) {
	if (ts.isIdentifier(name)) {
		identifiers.push(name);
		return;
	}
	for (const element of name.elements) {
		if (!ts.isOmittedExpression(element)) collectBindingIdentifiers(element.name, identifiers);
	}
}

function sourceFileBindings(sourceFile) {
	const bindings = [];
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			for (const specifier of statement.importClause.namedBindings.elements) {
				const symbol = checker.getSymbolAtLocation(specifier.name);
				if (symbol !== undefined) bindings.push({ kind: "import", name: specifier.name.text, node: specifier, symbol });
			}
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				const identifiers = [];
				collectBindingIdentifiers(declaration.name, identifiers);
				for (const identifier of identifiers) {
					const symbol = checker.getSymbolAtLocation(identifier);
					if (symbol !== undefined) bindings.push({ kind: "local", name: identifier.text, node: identifier, symbol });
				}
			}
			continue;
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement) ||
				ts.isModuleDeclaration(statement)) &&
			statement.name !== undefined &&
			ts.isIdentifier(statement.name)
		) {
			const symbol = checker.getSymbolAtLocation(statement.name);
			if (symbol !== undefined) bindings.push({ kind: "local", name: statement.name.text, node: statement.name, symbol });
		}
	}
	return bindings;
}

function importedLocalTarget(binding) {
	if (binding.kind !== "import") return undefined;
	if (binding.node.propertyName !== undefined) return symbolTargets.get(binding.symbol);
	return mappedIdentifier(binding.node.name);
}

function postRenameBindingName(binding) {
	if (removableAliases.has(binding.symbol)) return undefined;
	if (binding.kind === "import") return importedLocalTarget(binding) ?? binding.name;
	return symbolTargets.get(binding.symbol) ?? binding.name;
}

for (const sourceFile of program.getSourceFiles()) {
	if (sourceFile.isDeclarationFile) continue;
	const relativeSourceFile = relative(workspaceRoot, resolve(sourceFile.fileName));
	if (relativeSourceFile.startsWith(`..${sep}`) || relativeSourceFile === "..") continue;
	const bindings = sourceFileBindings(sourceFile);
	const usedNames = new Set(bindings.map((binding) => postRenameBindingName(binding)).filter((name) => name !== undefined));
	for (const imported of bindings.filter((binding) => binding.kind === "import")) {
		const target = importedLocalTarget(imported);
		if (target === undefined || target === imported.name) continue;
		for (const local of bindings.filter((binding) => binding.kind === "local" && binding.symbol !== imported.symbol)) {
			if (postRenameBindingName(local) !== target) continue;
			let suffix = 1;
			let replacement = `${target}Local`;
			while (usedNames.has(replacement)) {
				suffix += 1;
				replacement = `${target}Local${suffix}`;
			}
			assignTarget(local.symbol, replacement, `${workspacePath(sourceFile.fileName)}:${target} import/local collision`);
			usedNames.add(replacement);
		}
	}
	const bindingsByTarget = new Map();
	for (const binding of bindings) {
		const target = postRenameBindingName(binding);
		if (target === undefined) continue;
		const symbols = bindingsByTarget.get(target) ?? new Set();
		symbols.add(binding.symbol);
		bindingsByTarget.set(target, symbols);
	}
	for (const [target, symbols] of bindingsByTarget) {
		if (symbols.size < 2) continue;
		const canonicalSymbols = new Set([...symbols].map((symbol) => resolveTypescriptAlias(symbol)));
		if (canonicalSymbols.size < 2) continue;
		conflicts.push(`${workspacePath(sourceFile.fileName)}: post-rename binding collision for ${target}`);
	}
}

const removalRanges = new Map();
for (const symbol of removableAliases) {
	const declaration = removableDeclaration(symbol);
	if (declaration === undefined) continue;
	const sourceFile = declaration.getSourceFile();
	let end = declaration.end;
	const sourceText = sourceFile.text;
	if (sourceText.slice(end, end + 2) === "\r\n") end += 2;
	else if (sourceText[end] === "\n") end += 1;
	const ranges = removalRanges.get(sourceFile.fileName) ?? [];
	ranges.push({ start: declaration.getFullStart(), end });
	removalRanges.set(sourceFile.fileName, ranges);
}

function mappedIdentifier(node) {
	const direct = checker.getSymbolAtLocation(node);
	if (direct === undefined) return undefined;
	const directTarget = symbolTargets.get(direct);
	if (directTarget !== undefined) return directTarget;
	if ((direct.flags & ts.SymbolFlags.Alias) === 0 || !renameTexts.has(node.text)) return undefined;
	return symbolTargets.get(resolveTypescriptAlias(direct));
}

function insideRemoval(fileName, start, end) {
	return (removalRanges.get(fileName) ?? []).some((range) => start >= range.start && end <= range.end);
}

const editsByFile = new Map();
function addEdit(fileName, edit) {
	if (insideRemoval(fileName, edit.start, edit.end)) return;
	const edits = editsByFile.get(fileName) ?? [];
	if (edits.some((existing) => existing.start === edit.start && existing.end === edit.end && existing.text === edit.text)) return;
	edits.push(edit);
	editsByFile.set(fileName, edits);
}

function editSpecifier(sourceFile, node) {
	const imported = node.propertyName ?? node.name;
	const importedTarget = mappedIdentifier(imported);
	const localTarget = renameTexts.has(node.name.text) ? mappedIdentifier(node.name) : undefined;
	if (importedTarget === undefined && localTarget === undefined) return;
	const nextImported = importedTarget ?? imported.text;
	const nextLocal = localTarget ?? node.name.text;
	if (node.propertyName !== undefined && nextImported === nextLocal) {
		addEdit(sourceFile.fileName, {
			start: node.getStart(sourceFile),
			end: node.end,
			text: `${node.isTypeOnly ? "type " : ""}${nextImported}`,
		});
		return;
	}
	if (importedTarget !== undefined) addEdit(sourceFile.fileName, { start: imported.getStart(sourceFile), end: imported.end, text: importedTarget });
	if (node.propertyName !== undefined && localTarget !== undefined) addEdit(sourceFile.fileName, { start: node.name.getStart(sourceFile), end: node.name.end, text: localTarget });
}

for (const sourceFile of program.getSourceFiles()) {
	const absoluteSourceFile = resolve(sourceFile.fileName);
	const relativeSourceFile = relative(workspaceRoot, absoluteSourceFile);
	if (sourceFile.isDeclarationFile || relativeSourceFile.startsWith(`..${sep}`) || relativeSourceFile === "..") continue;
	function visit(node) {
		if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
			editSpecifier(sourceFile, node);
			return;
		}
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
			const next = node.moduleSpecifier.text.replace("foundation-v1-capabilities.ts", "foundation-capabilities.ts");
			if (next !== node.moduleSpecifier.text) {
				addEdit(sourceFile.fileName, { start: node.moduleSpecifier.getStart(sourceFile) + 1, end: node.moduleSpecifier.end - 1, text: next });
			}
		}
		if (ts.isIdentifier(node)) {
			const target = mappedIdentifier(node);
			if (target !== undefined && target !== node.text) {
				if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
					addEdit(sourceFile.fileName, { start: node.getStart(sourceFile), end: node.end, text: `${node.text}: ${target}` });
				} else {
					addEdit(sourceFile.fileName, { start: node.getStart(sourceFile), end: node.end, text: target });
				}
			}
			if (reviewedMapping.has(node.text) && target === undefined) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				unresolvedReferences.push(`${workspacePath(sourceFile.fileName)}:${line + 1}:${character + 1} ${node.text}`);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	addEdit(sourceFile.fileName, { start: 0, end: 0, text: "" });
}

for (const [fileName, ranges] of removalRanges) {
	const edits = editsByFile.get(fileName) ?? [];
	const merged = [];
	for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
		const previous = merged.at(-1);
		if (previous !== undefined && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	const lineBreak = readFileSync(fileName, "utf8").includes("\r\n") ? "\r\n" : "\n";
	for (const range of merged) edits.push({ ...range, text: lineBreak });
	editsByFile.set(fileName, edits);
}

function collectDocumentationFiles(directory, result = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectDocumentationFiles(join(directory, entry.name), result);
			continue;
		}
		if (!entry.isFile() || entry.name === "AGENTS.md") continue;
		if (entry.name.endsWith(".md") || entry.name.endsWith(".html")) result.push(join(directory, entry.name));
	}
	return result;
}

function migrateDocumentationTokens(text) {
	let output = text.replace(/[$A-Z_a-z][$\w]*/gu, (token) => reviewedMapping.get(token) ?? token);
	for (const [oldPhrase, currentPhrase] of documentationProductPhrases) output = output.replaceAll(oldPhrase, currentPhrase);
	return output;
}

function migrateDocumentationFile(fileName, text) {
	if (!fileName.endsWith(`${sep}CHANGELOG.md`)) {
		return migrateDocumentationTokens(text).replaceAll("foundation-v1-capabilities.ts", "foundation-capabilities.ts");
	}
	const start = text.indexOf("## [Unreleased]");
	if (start < 0) return text;
	const end = text.indexOf("\n## [", start + "## [Unreleased]".length);
	const sectionEnd = end < 0 ? text.length : end;
	const section = migrateDocumentationTokens(text.slice(start, sectionEnd)).replaceAll(
		"foundation-v1-capabilities.ts",
		"foundation-capabilities.ts",
	);
	return `${text.slice(0, start)}${section}${text.slice(sectionEnd)}`;
}

for (const fileName of collectDocumentationFiles(workspaceRoot)) {
	const sourceText = readFileSync(fileName, "utf8");
	const nextText = migrateDocumentationFile(fileName, sourceText);
	if (nextText !== sourceText) addEdit(fileName, { start: 0, end: sourceText.length, text: nextText });
}

const supplementaryFiles = ["packages/coding-agent/docs/docs.json"];
for (const relativePath of supplementaryFiles) {
	const fileName = resolve(workspaceRoot, relativePath);
	if (!existsSync(fileName)) continue;
	const sourceText = readFileSync(fileName, "utf8");
	const nextText = migrateDocumentationTokens(sourceText)
		.replaceAll("architecture-atlas-foundation-v1.md", "architecture-atlas-foundation.md")
		.replaceAll("foundation-v1-final-audit.md", "foundation-final-audit.md");
	if (nextText !== sourceText) addEdit(fileName, { start: 0, end: sourceText.length, text: nextText });
}

const fileRenames = [
	["packages/agent/src/harness/foundation-v1-capabilities.ts", "packages/agent/src/harness/foundation-capabilities.ts"],
	["packages/coding-agent/docs/architecture-atlas-foundation-v1.md", "packages/coding-agent/docs/architecture-atlas-foundation.md"],
	["packages/coding-agent/docs/foundation-v1-final-audit.md", "packages/coding-agent/docs/foundation-final-audit.md"],
].map(([oldPath, currentPath]) => [resolve(workspaceRoot, oldPath), resolve(workspaceRoot, currentPath)]);

for (const [oldPath, currentPath] of fileRenames) {
	if (existsSync(oldPath) && existsSync(currentPath)) conflicts.push(`file rename target already exists: ${workspacePath(currentPath)}`);
}

function uniqueSpecifiers(elements) {
	const selected = [];
	const indexByLocalName = new Map();
	for (const element of elements) {
		const key = element.name.text;
		const previousIndex = indexByLocalName.get(key);
		if (previousIndex === undefined) {
			indexByLocalName.set(key, selected.length);
			selected.push(element);
			continue;
		}
		const previous = selected[previousIndex];
		if (previous.isTypeOnly && !element.isTypeOnly) selected[previousIndex] = element;
	}
	return selected;
}

function normalizeDuplicateSpecifiers(sourceText, fileName) {
	if (!/\.(?:cts|mts|tsx?)$/u.test(fileName)) return sourceText;
	const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const printer = ts.createPrinter({ newLine: sourceText.includes("\r\n") ? ts.NewLineKind.CarriageReturnLineFeed : ts.NewLineKind.LineFeed });
	const edits = [];
	for (const statement of sourceFile.statements) {
		if (
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.length === 1 &&
			ts.isIdentifier(statement.declarationList.declarations[0].name) &&
			statement.declarationList.declarations[0].initializer !== undefined &&
			ts.isIdentifier(statement.declarationList.declarations[0].initializer) &&
			statement.declarationList.declarations[0].name.text === statement.declarationList.declarations[0].initializer.text
		) {
			edits.push({ start: statement.getFullStart(), end: statement.end, text: sourceText.includes("\r\n") ? "\r\n" : "\n" });
			continue;
		}
		if (ts.isTypeAliasDeclaration(statement) && ts.isTypeReferenceNode(statement.type) && ts.isIdentifier(statement.type.typeName) && statement.name.text === statement.type.typeName.text) {
			edits.push({ start: statement.getFullStart(), end: statement.end, text: sourceText.includes("\r\n") ? "\r\n" : "\n" });
			continue;
		}
		if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings)) {
			const elements = uniqueSpecifiers(statement.importClause.namedBindings.elements);
			if (elements.length === statement.importClause.namedBindings.elements.length) continue;
			const namedBindings = ts.factory.updateNamedImports(statement.importClause.namedBindings, elements);
			const importClause = ts.factory.updateImportClause(statement.importClause, statement.importClause.isTypeOnly, statement.importClause.name, namedBindings);
			const updated = ts.factory.updateImportDeclaration(statement, statement.modifiers, importClause, statement.moduleSpecifier, statement.attributes);
			edits.push({ start: statement.getStart(sourceFile), end: statement.end, text: printer.printNode(ts.EmitHint.Unspecified, updated, sourceFile) });
		}
		if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
			const elements = uniqueSpecifiers(statement.exportClause.elements);
			if (elements.length === statement.exportClause.elements.length) continue;
			const exportClause = ts.factory.updateNamedExports(statement.exportClause, elements);
			const updated = ts.factory.updateExportDeclaration(statement, statement.modifiers, statement.isTypeOnly, exportClause, statement.moduleSpecifier, statement.attributes);
			edits.push({ start: statement.getStart(sourceFile), end: statement.end, text: printer.printNode(ts.EmitHint.Unspecified, updated, sourceFile) });
		}
	}
	let output = sourceText;
	for (const edit of edits.sort((left, right) => right.start - left.start)) {
		output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
	}
	return output;
}

function applyEdits(fileName, edits) {
	const sourceText = readFileSync(fileName, "utf8");
	const sorted = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
	for (let index = 1; index < sorted.length; index += 1) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		if (current.end > previous.start) throw new Error(`Overlapping edits in ${workspacePath(fileName)}: ${JSON.stringify(current)} overlaps ${JSON.stringify(previous)}`);
	}
	let output = sourceText;
	for (const edit of sorted) output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
	return normalizeDuplicateSpecifiers(output, fileName);
}

const changedFiles = [];
const pendingWrites = [];
for (const [fileName, edits] of [...editsByFile].sort(([left], [right]) => left.localeCompare(right))) {
	if (!existsSync(fileName) || !statSync(fileName).isFile()) continue;
	const output = applyEdits(fileName, edits);
	if (output === readFileSync(fileName, "utf8")) continue;
	pendingWrites.push([fileName, output]);
	changedFiles.push(workspacePath(fileName));
}
for (const [oldPath, currentPath] of fileRenames) {
	if (!existsSync(oldPath)) continue;
	changedFiles.push(`${workspacePath(oldPath)} -> ${workspacePath(currentPath)}`);
}

process.stdout.write(`reviewed old -> current mapping (${reviewedMapping.size})\n`);
for (const [oldName, currentName] of reviewedMapping) process.stdout.write(`  ${oldName} -> ${currentName}\n`);
process.stdout.write(`conflicts (${conflicts.length})\n`);
for (const conflict of conflicts.sort()) process.stdout.write(`  ${conflict}\n`);
process.stdout.write(`unresolved references (${unresolvedReferences.length})\n`);
for (const reference of unresolvedReferences.sort()) process.stdout.write(`  ${reference}\n`);
process.stdout.write(`changed files (${changedFiles.length})\n`);
for (const fileName of changedFiles.sort()) process.stdout.write(`  ${fileName}\n`);

if (conflicts.length > 0 || unresolvedReferences.length > 0) process.exitCode = 1;
else if (checkOnly && changedFiles.length > 0) process.exitCode = 1;
else if (!checkOnly) {
	for (const [fileName, output] of pendingWrites) writeFileSync(fileName, output);
	for (const [oldPath, currentPath] of fileRenames) {
		if (existsSync(oldPath)) renameSync(oldPath, currentPath);
	}
}
