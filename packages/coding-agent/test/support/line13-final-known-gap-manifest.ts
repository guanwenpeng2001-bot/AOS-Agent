import { line13KnownGapCasesAc01Ac08 } from "../line13-known-gap-shards/ac-01-08.ts";
import { line13KnownGapCasesAc09Ac16 } from "../line13-known-gap-shards/ac-09-16.ts";
import { line13KnownGapCasesAc17Ac24 } from "../line13-known-gap-shards/ac-17-24.ts";
import {
	loadLine13KnownGapManifest,
	type Line13KnownGapCase,
	type Line13KnownGapManifest,
} from "./line13-known-gaps.ts";

export const LINE13_FINAL_KNOWN_GAP_CASE_SHARDS = Object.freeze([
	line13KnownGapCasesAc01Ac08,
	line13KnownGapCasesAc09Ac16,
	line13KnownGapCasesAc17Ac24,
]);

export const LINE13_FINAL_KNOWN_GAP_CASES: readonly Line13KnownGapCase[] = Object.freeze(
	LINE13_FINAL_KNOWN_GAP_CASE_SHARDS.flatMap((shard) => shard.cases).sort((left, right) => left.entry.ac.localeCompare(right.entry.ac)),
);

export function loadLine13FinalKnownGapManifest(): Line13KnownGapManifest {
	return loadLine13KnownGapManifest(LINE13_FINAL_KNOWN_GAP_CASE_SHARDS);
}
