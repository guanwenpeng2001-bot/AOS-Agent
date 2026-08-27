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
	["External Agent Adapter v1", "External Agent Connector"],
	["MCP OAuth and resources/prompts v1", "MCP OAuth and resources/prompts"],
	["Task Credential / Lease v1", "Task Credential / Lease"],
	["Sandbox Operation Worker v1", "Sandbox Operation Worker"],
	["External Agent Adapter (v1)", "External Agent Connector"],
	["Execution Audit / Replay / External Mapping Contract (v1)", "Execution Audit / Replay Contract"],
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
	["the v1 boundary for the External Agent Adapter", "the current boundary for the External Agent Connector"],
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

const valueMeaning = 1;
const typeMeaning = 2;
const namespaceMeaning = 4;
const initialSymbolTargets = new Map(symbolTargets);

function symbolMeaning(symbol) {
	const resolved = resolveTypescriptAlias(symbol);
	let meaning = 0;
	if ((resolved.flags & ts.SymbolFlags.Value) !== 0) meaning |= valueMeaning;
	if ((resolved.flags & ts.SymbolFlags.Type) !== 0) meaning |= typeMeaning;
	if ((resolved.flags & ts.SymbolFlags.Namespace) !== 0) meaning |= namespaceMeaning;
	return meaning === 0 ? valueMeaning | typeMeaning | namespaceMeaning : meaning;
}

function functionScope(node) {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isFunctionLike(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isClassStaticBlockDeclaration(current)) return current;
	}
	return node.getSourceFile();
}

function declarationScope(node) {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current) || ts.isClassStaticBlockDeclaration(current)) return current;
		if (ts.isBlock(current)) {
			if (ts.isFunctionLike(current.parent) && current.parent.body === current) return current.parent;
			if (ts.isCatchClause(current.parent) && current.parent.block === current) return current.parent;
			return current;
		}
	}
	return node.getSourceFile();
}

function variableScope(declaration) {
	if (!ts.isVariableDeclarationList(declaration.parent)) return ts.isCatchClause(declaration.parent) ? declaration.parent : declarationScope(declaration);
	if ((declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0) return functionScope(declaration);
	const owner = declaration.parent.parent;
	if (ts.isForStatement(owner) || ts.isForInStatement(owner) || ts.isForOfStatement(owner)) return owner;
	return declarationScope(declaration);
}

function bindingMeaning(declaration, symbol, typeOnly = false) {
	if (ts.isImportClause(declaration) || ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) {
		return valueMeaning | typeMeaning | namespaceMeaning;
	}
	if (typeOnly) return symbolMeaning(symbol) & (typeMeaning | namespaceMeaning);
	if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isTypeParameterDeclaration(declaration)) return typeMeaning;
	if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration) || ts.isEnumDeclaration(declaration)) return valueMeaning | typeMeaning;
	if (ts.isModuleDeclaration(declaration)) return valueMeaning | namespaceMeaning;
	return valueMeaning;
}

function sourceFileBindings(sourceFile) {
	const bindings = [];
	function addIdentifiers(name, declaration, scope, kind, typeOnly = false) {
		const identifiers = [];
		collectBindingIdentifiers(name, identifiers);
		for (const identifier of identifiers) {
			const symbol = checker.getSymbolAtLocation(identifier);
			if (symbol === undefined) continue;
			bindings.push({
				declaration: ts.isBindingElement(identifier.parent) ? identifier.parent : declaration,
				kind,
				meaning: bindingMeaning(declaration, symbol, typeOnly),
				name: identifier.text,
				node: identifier,
				scope,
				scopeDepth: (() => {
					let depth = 0;
					for (let current = scope; current.parent !== undefined; current = current.parent) depth += 1;
					return depth;
				})(),
				symbol,
			});
		}
	}
	function visit(node) {
		if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
			const { importClause } = node;
			if (importClause.name !== undefined) addIdentifiers(importClause.name, importClause, sourceFile, "import", importClause.isTypeOnly);
			if (importClause.namedBindings !== undefined && ts.isNamespaceImport(importClause.namedBindings)) {
				addIdentifiers(importClause.namedBindings.name, importClause.namedBindings, sourceFile, "import", importClause.isTypeOnly);
			} else if (importClause.namedBindings !== undefined) {
				for (const specifier of importClause.namedBindings.elements) {
					addIdentifiers(specifier.name, specifier, sourceFile, "import", importClause.isTypeOnly || specifier.isTypeOnly);
				}
			}
		} else if (ts.isParameter(node)) {
			addIdentifiers(node.name, node, node.parent, "parameter");
		} else if (ts.isVariableDeclaration(node)) {
			addIdentifiers(node.name, node, variableScope(node), ts.isCatchClause(node.parent) ? "catch" : "local");
		} else if (ts.isTypeParameterDeclaration(node)) {
			addIdentifiers(node.name, node, node.parent, "type-parameter");
		} else if (
			(ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node) ||
				ts.isInterfaceDeclaration(node) ||
				ts.isTypeAliasDeclaration(node) ||
				ts.isEnumDeclaration(node) ||
				ts.isModuleDeclaration(node)) &&
			node.name !== undefined &&
			ts.isIdentifier(node.name)
		) {
			addIdentifiers(node.name, node, declarationScope(node), "local");
		} else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name !== undefined) {
			addIdentifiers(node.name, node, node, "local");
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return bindings;
}

function initialBindingTarget(binding) {
	const directTarget = initialSymbolTargets.get(binding.symbol);
	if (directTarget !== undefined) return directTarget;
	if ((binding.symbol.flags & ts.SymbolFlags.Alias) === 0 || !renameTexts.has(binding.name)) return undefined;
	return initialSymbolTargets.get(resolveTypescriptAlias(binding.symbol));
}

function postRenameBindingName(binding) {
	if (removableAliases.has(binding.symbol)) return undefined;
	return symbolTargets.get(binding.symbol) ?? initialBindingTarget(binding) ?? binding.name;
}

function scopeContains(scope, node) {
	for (let current = node; current !== undefined; current = current.parent) {
		if (current === scope) return true;
	}
	return false;
}

function identifierIsPreservedName(node) {
	const { parent } = node;
	if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) return true;
	if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
	return (
		(ts.isPropertyAssignment(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isPropertySignature(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isMethodSignature(parent) ||
			ts.isGetAccessorDeclaration(parent) ||
			ts.isSetAccessorDeclaration(parent) ||
			ts.isEnumMember(parent) ||
			ts.isJsxAttribute(parent)) &&
		parent.name === node
	);
}

function identifierIsLexicalReference(node, bindingNodes) {
	if (bindingNodes.has(node) || identifierIsPreservedName(node)) return false;
	const { parent } = node;
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if (ts.isQualifiedName(parent) && parent.right === node) return false;
	return true;
}

function referenceMeaning(node) {
	for (let current = node; current.parent !== undefined; current = current.parent) {
		if (ts.isTypeQueryNode(current.parent)) return valueMeaning;
		if (!ts.isQualifiedName(current.parent)) break;
	}
	return ts.isPartOfTypeNode(node) ? typeMeaning | namespaceMeaning : valueMeaning | namespaceMeaning;
}

function declarationIsExported(declaration) {
	let owner = declaration;
	while (ts.isBindingElement(owner) || ts.isObjectBindingPattern(owner) || ts.isArrayBindingPattern(owner)) owner = owner.parent;
	if (ts.canHaveModifiers(owner) && ts.getModifiers(owner)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true) return true;
	if (ts.isVariableDeclaration(owner) && ts.isVariableDeclarationList(owner.parent) && ts.isVariableStatement(owner.parent.parent)) {
		return ts.getModifiers(owner.parent.parent)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
	}
	return false;
}

function symbolCanBeRenamed(symbol, analysis) {
	const records = analysis.bindingsBySymbol.get(symbol);
	if (records === undefined || records.length === 0 || removableAliases.has(symbol) || analysis.exportedLocalSymbols.has(symbol)) return false;
	return (symbol.declarations ?? []).every(
		(declaration) => declaration.getSourceFile() === analysis.sourceFile && !declarationIsExported(declaration) && records.some((record) => record.declaration === declaration),
	);
}

function addConflict(message) {
	if (!conflicts.includes(message)) conflicts.push(message);
}

const sourceAnalyses = [];
for (const sourceFile of program.getSourceFiles()) {
	if (sourceFile.isDeclarationFile) continue;
	const relativeSourceFile = relative(workspaceRoot, resolve(sourceFile.fileName));
	if (relativeSourceFile.startsWith(`..${sep}`) || relativeSourceFile === "..") continue;
	const bindings = sourceFileBindings(sourceFile);
	const bindingNodes = new Set(bindings.map((binding) => binding.node));
	const bindingsBySymbol = new Map();
	for (const binding of bindings) {
		const records = bindingsBySymbol.get(binding.symbol) ?? [];
		records.push(binding);
		bindingsBySymbol.set(binding.symbol, records);
	}
	const exportedLocalSymbols = new Set();
	for (const statement of sourceFile.statements) {
		if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
		for (const specifier of statement.exportClause.elements) {
			const symbol = checker.getExportSpecifierLocalTargetSymbol(specifier);
			if (symbol !== undefined) exportedLocalSymbols.add(symbol);
		}
	}
	const references = [];
	const identifierNames = new Set();
	function visitReference(node) {
		if (ts.isIdentifier(node)) {
			identifierNames.add(node.text);
			if (identifierIsLexicalReference(node, bindingNodes)) {
				const symbol = checker.getSymbolAtLocation(node);
				const target =
					symbol === undefined
						? undefined
						: initialSymbolTargets.get(symbol) ??
							((symbol.flags & ts.SymbolFlags.Alias) !== 0 && renameTexts.has(node.text)
								? initialSymbolTargets.get(resolveTypescriptAlias(symbol))
								: undefined);
				if (symbol !== undefined && target !== undefined && target !== node.text) references.push({ meaning: referenceMeaning(node), node, symbol, target });
			}
		}
		ts.forEachChild(node, visitReference);
	}
	visitReference(sourceFile);
	sourceAnalyses.push({ bindings, bindingsBySymbol, exportedLocalSymbols, identifierNames, references, sourceFile });
}

sourceAnalyses.sort((left, right) => workspacePath(left.sourceFile.fileName).localeCompare(workspacePath(right.sourceFile.fileName)));
for (const analysis of sourceAnalyses) {
	const usedNames = new Set([
		...analysis.identifierNames,
		...analysis.bindings.map((binding) => postRenameBindingName(binding)).filter((name) => name !== undefined),
	]);
	function renameConflict(symbol, target, reason) {
		if (!symbolCanBeRenamed(symbol, analysis)) {
			addConflict(`${reason}: ${symbol.name} is not a safe local binding`);
			return false;
		}
		let suffix = 1;
		let replacement = `${target}Local`;
		while (usedNames.has(replacement)) {
			suffix += 1;
			replacement = `${target}Local${suffix}`;
		}
		assignTarget(symbol, replacement, reason);
		usedNames.add(replacement);
		return true;
	}

	let changed = true;
	while (changed) {
		changed = false;
		const activeBindings = analysis.bindings.filter((binding) => postRenameBindingName(binding) !== undefined);
		for (let leftIndex = 0; leftIndex < activeBindings.length; leftIndex += 1) {
			const left = activeBindings[leftIndex];
			const target = postRenameBindingName(left);
			if (target === undefined) continue;
			for (let rightIndex = leftIndex + 1; rightIndex < activeBindings.length; rightIndex += 1) {
				const right = activeBindings[rightIndex];
				if (left.symbol === right.symbol || left.scope !== right.scope || postRenameBindingName(right) !== target || (left.meaning & right.meaning) === 0) continue;
				if (resolveTypescriptAlias(left.symbol) === resolveTypescriptAlias(right.symbol)) continue;
				const leftMapped = initialBindingTarget(left) === target;
				const rightMapped = initialBindingTarget(right) === target;
				const reason = `${workspacePath(analysis.sourceFile.fileName)}:${target} post-rename binding collision`;
				if (leftMapped !== rightMapped) {
					if (renameConflict(leftMapped ? right.symbol : left.symbol, target, reason)) changed = true;
					break;
				}
				addConflict(`${reason}: ${left.symbol.name} conflicts with ${right.symbol.name}`);
			}
			if (changed) break;
		}
		if (changed) continue;

		for (const reference of analysis.references) {
			const candidates = analysis.bindings
				.filter(
					(binding) =>
						postRenameBindingName(binding) === reference.target &&
						(binding.meaning & reference.meaning) !== 0 &&
						scopeContains(binding.scope, reference.node),
				)
				.sort((left, right) => right.scopeDepth - left.scopeDepth || left.node.getStart(analysis.sourceFile) - right.node.getStart(analysis.sourceFile));
			const winner = candidates[0];
			if (winner === undefined || winner.symbol === reference.symbol || resolveTypescriptAlias(winner.symbol) === resolveTypescriptAlias(reference.symbol)) continue;
			const reason = `${workspacePath(analysis.sourceFile.fileName)}:${reference.target} lexical capture at ${analysis.sourceFile.getLineAndCharacterOfPosition(reference.node.getStart(analysis.sourceFile)).line + 1}`;
			if (initialBindingTarget(winner) === reference.target) {
				addConflict(`${reason}: mapped ${winner.symbol.name} conflicts with ${reference.symbol.name}`);
				continue;
			}
			if (renameConflict(winner.symbol, reference.target, reason)) {
				changed = true;
				break;
			}
		}
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

function specifierUsesDependencyOwnedKey(node) {
	let declaration = node.parent;
	while (!ts.isImportDeclaration(declaration) && !ts.isExportDeclaration(declaration)) {
		if (ts.isSourceFile(declaration.parent)) return false;
		declaration = declaration.parent;
	}
	if (declaration.moduleSpecifier === undefined || !ts.isStringLiteralLike(declaration.moduleSpecifier)) return false;
	const moduleSymbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
	const declarationFiles = new Set((moduleSymbol?.declarations ?? []).map((moduleDeclaration) => resolve(moduleDeclaration.getSourceFile().fileName)));
	if (declarationFiles.size === 0) return !declaration.moduleSpecifier.text.startsWith(".");
	return [...declarationFiles].some((fileName) => {
		const relativeFileName = relative(workspaceRoot, fileName);
		return relativeFileName === ".." || relativeFileName.startsWith(`..${sep}`) || relativeFileName.split(sep).includes("node_modules");
	});
}

function editSpecifier(sourceFile, node) {
	const imported = node.propertyName ?? node.name;
	const importedTarget = !specifierUsesDependencyOwnedKey(node) && reviewedMapping.has(imported.text) ? mappedIdentifier(imported) : undefined;
	const localTarget = mappedIdentifier(node.name);
	if (importedTarget === undefined && localTarget === undefined) return;
	const nextImported = importedTarget ?? imported.text;
	const nextLocal = localTarget ?? node.name.text;
	if (node.propertyName === undefined && importedTarget === undefined && localTarget !== undefined) {
		addEdit(sourceFile.fileName, {
			start: node.getStart(sourceFile),
			end: node.end,
			text: `${node.isTypeOnly ? "type " : ""}${imported.text} as ${localTarget}`,
		});
		return;
	}
	if (node.propertyName !== undefined && importedTarget !== undefined && nextImported === nextLocal) {
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
			if (identifierIsPreservedName(node)) return;
			const target = mappedIdentifier(node);
			if (target !== undefined && target !== node.text) {
				if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
					addEdit(sourceFile.fileName, { start: node.getStart(sourceFile), end: node.end, text: `${node.text}: ${target}` });
				} else if (
					ts.isBindingElement(node.parent) &&
					node.parent.name === node &&
					node.parent.propertyName === undefined &&
					ts.isObjectBindingPattern(node.parent.parent)
				) {
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
