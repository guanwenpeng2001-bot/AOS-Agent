import { line13KnownGapCasesAc01Ac08 } from "../line13-known-gap-shards/ac-01-08.ts";
import { line13KnownGapCasesAc09Ac16 } from "../line13-known-gap-shards/ac-09-16.ts";
import { line13KnownGapCasesAc17Ac24 } from "../line13-known-gap-shards/ac-17-24.ts";
import {
	loadLine13KnownGapManifest,
	loadLine13KnownGapTransition,
	type Line13KnownGapCase,
	type Line13KnownGapManifest,
	type Line13KnownGapTransition,
	type Line13ResolvedCase,
} from "./line13-known-gaps.ts";

export const LINE13_FINAL_KNOWN_GAP_CASE_SHARDS = Object.freeze([
	line13KnownGapCasesAc01Ac08,
	line13KnownGapCasesAc09Ac16,
	line13KnownGapCasesAc17Ac24,
]);

const LINE13_FINAL_KNOWN_GAP_TRANSITION = loadLine13KnownGapTransition(LINE13_FINAL_KNOWN_GAP_CASE_SHARDS);

export const LINE13_FINAL_KNOWN_GAP_CASES: readonly Line13KnownGapCase[] =
	LINE13_FINAL_KNOWN_GAP_TRANSITION.knownGapManifest.cases;

export const LINE13_FINAL_RESOLVED_CASES: readonly Line13ResolvedCase[] =
	LINE13_FINAL_KNOWN_GAP_TRANSITION.resolvedCases;

export function loadLine13FinalKnownGapManifest(): Line13KnownGapManifest {
	return loadLine13KnownGapManifest(LINE13_FINAL_KNOWN_GAP_CASE_SHARDS);
}

export function loadLine13FinalKnownGapTransition(): Line13KnownGapTransition {
	return loadLine13KnownGapTransition(LINE13_FINAL_KNOWN_GAP_CASE_SHARDS);
}
