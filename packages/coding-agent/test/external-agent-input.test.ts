import { type ArtifactDigest, fingerprintFoundationValue } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	type CanonicalExternalAgentArtifactReference,
	type CanonicalExternalAgentInput,
	cloneCanonicalExternalAgentInput,
	type ExternalAgentArtifactInspection,
	type ExternalAgentInputError,
	type ExternalAgentInputErrorCode,
	type ExternalAgentInputReasonCode,
	fingerprintCanonicalExternalAgentInput,
	gateCanonicalExternalAgentInputBeforeAcceptance,
	isCanonicalExternalAgentInput,
	parseCanonicalExternalAgentInput,
	serializeCanonicalExternalAgentInput,
	validateCanonicalExternalAgentInput,
} from "../src/core/external-agent-input.ts";

const IMAGE_ID = "1".repeat(64);
const FILE_ID = "2".repeat(64);
const OTHER_ID = "3".repeat(64);

function digest(id: string): ArtifactDigest {
	return `sha256:${id}`;
}

function imageArtifact(): CanonicalExternalAgentArtifactReference {
	return {
		schemaVersion: 1,
		artifactId: IMAGE_ID,
		kind: "image",
		digest: digest(IMAGE_ID),
		mediaType: "image/png",
		sizeBytes: 3,
		provenance: { source: "artifact_store", producer: "rpc-ingress", trust: "trusted" },
		readHandle: { kind: "artifact_store", ref: IMAGE_ID },
	};
}

function workspaceFileArtifact(): CanonicalExternalAgentArtifactReference {
	return {
		schemaVersion: 1,
		artifactId: FILE_ID,
		kind: "file",
		digest: digest(FILE_ID),
		mediaType: "text/plain",
		sizeBytes: 7,
		provenance: { source: "workspace", producer: "rpc-ingress", trust: "trusted" },
		readHandle: {
			kind: "workspace_relative",
			workspaceId: "workspace-main",
			relativePath: "docs/evidence.txt",
			ref: "workspace-file-ref",
		},
	};
}

function validInput(
	artifacts: readonly CanonicalExternalAgentArtifactReference[] = [imageArtifact(), workspaceFileArtifact()],
): CanonicalExternalAgentInput {
	return { schemaVersion: 1, text: "Preserve every safe input reference", artifacts };
}

function inspectionFor(reference: CanonicalExternalAgentArtifactReference): ExternalAgentArtifactInspection {
	return {
		artifactId: reference.artifactId,
		ref: reference.readHandle.ref,
		digest: reference.digest,
		mediaType: reference.mediaType,
		sizeBytes: reference.sizeBytes,
		trusted: true,
		workspaceContained: true,
	};
}

function expectInputError(
	error: ExternalAgentInputError,
	code: ExternalAgentInputErrorCode,
	reasonCode: ExternalAgentInputReasonCode,
): void {
	expect(error).toMatchObject({ code, reasonCode, retryable: false });
	expect(Object.keys(error)).toEqual(["code", "reasonCode", "retryable"]);
}

function expectValidationError(
	value: unknown,
	code: ExternalAgentInputErrorCode,
	reasonCode: ExternalAgentInputReasonCode,
): ExternalAgentInputError {
	const checked = validateCanonicalExternalAgentInput(value);
	expect(checked.ok).toBe(false);
	if (checked.ok) throw new Error("Expected External Agent input validation to fail");
	expectInputError(checked.error, code, reasonCode);
	return checked.error;
}

describe("canonical External Agent input", () => {
	it("validates the exact text plus metadata-only Artifact reference shape", () => {
		const input = validInput();
		expect(isCanonicalExternalAgentInput(input)).toBe(true);
		expect(validateCanonicalExternalAgentInput(input)).toEqual({ ok: true, value: input });

		const raw = serializeCanonicalExternalAgentInput(input);
		expect(raw).toContain(`"artifactId":"${IMAGE_ID}"`);
		expect(raw).toContain('"provenance":{"producer":"rpc-ingress","source":"artifact_store","trust":"trusted"}');
		expect(raw).toContain('"readHandle":{"kind":"workspace_relative"');
		expect(raw).not.toContain('"data"');
		expect(raw).not.toContain('"bytes"');
		expect(raw).not.toContain('"url"');
		expect(parseCanonicalExternalAgentInput(raw)).toEqual({ ok: true, value: input });
	});

	it("clones and freezes every nested input field without retaining aliases", () => {
		const mutable = structuredClone(validInput()) as {
			schemaVersion: 1;
			text: string;
			artifacts: CanonicalExternalAgentArtifactReference[];
		};
		const clone = cloneCanonicalExternalAgentInput(mutable);
		mutable.text = "mutated";
		mutable.artifacts.length = 0;

		expect(clone).toEqual(validInput());
		expect(Object.isFrozen(clone)).toBe(true);
		expect(Object.isFrozen(clone.artifacts)).toBe(true);
		expect(Object.isFrozen(clone.artifacts[0])).toBe(true);
		expect(Object.isFrozen(clone.artifacts[0]?.provenance)).toBe(true);
		expect(Object.isFrozen(clone.artifacts[0]?.readHandle)).toBe(true);
	});

	it("rejects unknown fields, raw bodies, URLs, untrusted refs, and invalid digest identity", () => {
		const input = validInput();
		expectValidationError({ ...input, images: [] }, "external_binding_invalid", "input_invalid");
		expectValidationError(
			{ ...input, artifacts: [{ ...imageArtifact(), extra: true }] },
			"external_binding_invalid",
			"input_invalid",
		);
		const contentError = expectValidationError(
			{ ...input, artifacts: [{ ...imageArtifact(), data: "secret artifact contents" }] },
			"external_binding_invalid",
			"unsafe_reference",
		);
		expect(contentError.message).not.toContain("secret artifact contents");
		expect(JSON.stringify(contentError)).not.toContain("secret artifact contents");
		const urlError = expectValidationError(
			{
				...input,
				artifacts: [
					{
						...imageArtifact(),
						readHandle: { kind: "artifact_store", ref: IMAGE_ID, url: "https://secret.invalid/private" },
					},
				],
			},
			"external_binding_invalid",
			"unsafe_reference",
		);
		expect(urlError.message).not.toContain("secret.invalid");
		expect(JSON.stringify(urlError)).not.toContain("secret.invalid");
		expectValidationError(
			{
				...input,
				artifacts: [
					{
						...imageArtifact(),
						provenance: { source: "artifact_store", producer: "rpc-ingress", trust: "untrusted" },
					},
				],
			},
			"external_binding_invalid",
			"untrusted_artifact",
		);
		expectValidationError(
			{ ...input, artifacts: [{ ...imageArtifact(), digest: digest(OTHER_ID) }] },
			"external_binding_invalid",
			"digest_mismatch",
		);
	});

	it("rejects absolute paths, traversal, and non-canonical workspace paths", () => {
		for (const relativePath of [
			"C:\\private\\secret.txt",
			"/etc/passwd",
			"../secret.txt",
			"docs/../secret.txt",
			"docs\\secret.txt",
			"docs//secret.txt",
			"docs/evidence.txt:stream",
		]) {
			expectValidationError(
				{
					...validInput(),
					artifacts: [
						{
							...workspaceFileArtifact(),
							readHandle: { ...workspaceFileArtifact().readHandle, relativePath },
						},
					],
				},
				"external_path_outside_workspace",
				"input_workspace_escape",
			);
		}
	});

	it("rejects image MIME classification bypasses", () => {
		expectValidationError(
			{ ...validInput(), artifacts: [{ ...imageArtifact(), kind: "file" }] },
			"external_binding_invalid",
			"reference_mismatch",
		);
		expectValidationError(
			{ ...validInput(), artifacts: [{ ...workspaceFileArtifact(), kind: "image" }] },
			"external_binding_invalid",
			"reference_mismatch",
		);
	});

	it("parses invalid JSON into one stable, redacted error", () => {
		const parsed = parseCanonicalExternalAgentInput('{"url":"https://secret.invalid"');
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expectInputError(parsed.error, "external_binding_invalid", "input_invalid");
			expect(parsed.error.message).toBe("External Agent input binding is invalid");
			expect(parsed.error.message).not.toContain("secret.invalid");
			expect(JSON.stringify(parsed.error)).not.toContain("secret.invalid");
		}
	});

	it("fingerprints the complete canonical input and preserves Artifact order", () => {
		const input = validInput();
		const expected = `sha256:${fingerprintFoundationValue(input).value}`;
		expect(fingerprintCanonicalExternalAgentInput(input)).toBe(expected);

		const changedInputs: CanonicalExternalAgentInput[] = [
			{ ...input, text: `${input.text}!` },
			{ ...input, artifacts: [...input.artifacts].reverse() },
			{
				...input,
				artifacts: [
					imageArtifact(),
					{
						...workspaceFileArtifact(),
						provenance: { ...workspaceFileArtifact().provenance, producer: "sdk-ingress" },
					},
				],
			},
			{
				...input,
				artifacts: [
					imageArtifact(),
					{
						...workspaceFileArtifact(),
						readHandle: {
							kind: "workspace_relative",
							workspaceId: "workspace-other",
							relativePath: "docs/evidence.txt",
							ref: "workspace-file-ref",
						},
					},
				],
			},
			{
				...input,
				artifacts: [
					imageArtifact(),
					{
						...workspaceFileArtifact(),
						readHandle: {
							kind: "workspace_relative",
							workspaceId: "workspace-main",
							relativePath: "docs/other.txt",
							ref: "workspace-file-other",
						},
					},
				],
			},
		];
		for (const changed of changedInputs) {
			expect(fingerprintCanonicalExternalAgentInput(changed)).not.toBe(expected);
		}
	});
});

describe("accepted-before External Agent input gate", () => {
	it("admits supported inputs only after exact trusted metadata inspection", async () => {
		const inspected: CanonicalExternalAgentArtifactReference[] = [];
		const result = await gateCanonicalExternalAgentInputBeforeAcceptance(validInput(), {
			capabilities: { artifacts: true, images: true },
			inspectArtifact: (reference) => {
				inspected.push(reference);
				return inspectionFor(reference);
			},
		});

		expect(result).toEqual({
			ok: true,
			input: validInput(),
			requestFingerprint: fingerprintCanonicalExternalAgentInput(validInput()),
		});
		expect(inspected).toHaveLength(2);
		expect(inspected.every((reference) => Object.isFrozen(reference))).toBe(true);
	});

	it("admits text-only input without Artifact capability or inspection", async () => {
		let inspectionCalls = 0;
		const input = validInput([]);
		const result = await gateCanonicalExternalAgentInputBeforeAcceptance(input, {
			capabilities: { artifacts: false, images: false },
			inspectArtifact: () => {
				inspectionCalls++;
				throw new Error("must not inspect");
			},
		});
		expect(result.ok).toBe(true);
		expect(inspectionCalls).toBe(0);
	});

	it("rejects unsupported Artifact and image capability before inspection", async () => {
		for (const fixture of [
			{ input: validInput([workspaceFileArtifact()]), capabilities: { artifacts: false, images: false } },
			{ input: validInput([imageArtifact()]), capabilities: { artifacts: true, images: false } },
		]) {
			let inspectionCalls = 0;
			let connectorCalls = 0;
			const result = await gateCanonicalExternalAgentInputBeforeAcceptance(fixture.input, {
				capabilities: fixture.capabilities,
				inspectArtifact: () => {
					inspectionCalls++;
					throw new Error("must not inspect");
				},
			});
			if (result.ok) connectorCalls++;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expectInputError(result.error, "external_capability_mismatch", "input_capability_unsupported");
			}
			expect(inspectionCalls).toBe(0);
			expect(connectorCalls).toBe(0);
		}
	});

	it("rejects claimed and inspected oversize input without Connector side effects", async () => {
		let inspectionCalls = 0;
		const claimed = await gateCanonicalExternalAgentInputBeforeAcceptance(validInput([imageArtifact()]), {
			capabilities: { artifacts: true, images: true },
			limits: { maxArtifactBytes: 2 },
			inspectArtifact: (reference) => {
				inspectionCalls++;
				return inspectionFor(reference);
			},
		});
		expect(claimed.ok).toBe(false);
		if (!claimed.ok) expectInputError(claimed.error, "external_resource_limit_exceeded", "input_oversize");
		expect(inspectionCalls).toBe(0);

		const inspected = await gateCanonicalExternalAgentInputBeforeAcceptance(validInput([imageArtifact()]), {
			capabilities: { artifacts: true, images: true },
			limits: { maxArtifactBytes: 4 },
			inspectArtifact: (reference) => ({ ...inspectionFor(reference), sizeBytes: 5 }),
		});
		expect(inspected.ok).toBe(false);
		if (!inspected.ok) expectInputError(inspected.error, "external_resource_limit_exceeded", "input_oversize");
	});

	it("rejects untrusted provenance and untrusted inspection", async () => {
		let inspectionCalls = 0;
		const untrustedCandidate = {
			...validInput(),
			artifacts: [
				{
					...imageArtifact(),
					provenance: { source: "artifact_store", producer: "rpc-ingress", trust: "untrusted" },
				},
			],
		};
		const candidateResult = await gateCanonicalExternalAgentInputBeforeAcceptance(untrustedCandidate, {
			capabilities: { artifacts: true, images: true },
			inspectArtifact: (reference) => {
				inspectionCalls++;
				return inspectionFor(reference);
			},
		});
		expect(candidateResult.ok).toBe(false);
		if (!candidateResult.ok) expectInputError(candidateResult.error, "external_binding_invalid", "untrusted_artifact");
		expect(inspectionCalls).toBe(0);

		const inspectionResult = await gateCanonicalExternalAgentInputBeforeAcceptance(validInput([imageArtifact()]), {
			capabilities: { artifacts: true, images: true },
			inspectArtifact: (reference) => ({ ...inspectionFor(reference), trusted: false }),
		});
		expect(inspectionResult.ok).toBe(false);
		if (!inspectionResult.ok) {
			expectInputError(inspectionResult.error, "external_binding_invalid", "untrusted_artifact");
		}
	});

	it("rejects claimed or inspected digest mismatch deterministically", async () => {
		let inspectionCalls = 0;
		const claimed = await gateCanonicalExternalAgentInputBeforeAcceptance(
			{ ...validInput(), artifacts: [{ ...imageArtifact(), digest: digest(OTHER_ID) }] },
			{
				capabilities: { artifacts: true, images: true },
				inspectArtifact: (reference) => {
					inspectionCalls++;
					return inspectionFor(reference);
				},
			},
		);
		expect(claimed.ok).toBe(false);
		if (!claimed.ok) expectInputError(claimed.error, "external_binding_invalid", "digest_mismatch");
		expect(inspectionCalls).toBe(0);

		const inspected = await gateCanonicalExternalAgentInputBeforeAcceptance(validInput([imageArtifact()]), {
			capabilities: { artifacts: true, images: true },
			inspectArtifact: (reference) => ({
				...inspectionFor(reference),
				artifactId: OTHER_ID,
				digest: digest(OTHER_ID),
			}),
		});
		expect(inspected.ok).toBe(false);
		if (!inspected.ok) expectInputError(inspected.error, "external_binding_invalid", "digest_mismatch");
	});

	it("rejects lexical and resolved workspace escape before acceptance", async () => {
		let inspectionCalls = 0;
		const lexical = await gateCanonicalExternalAgentInputBeforeAcceptance(
			{
				...validInput(),
				artifacts: [
					{
						...workspaceFileArtifact(),
						readHandle: { ...workspaceFileArtifact().readHandle, relativePath: "../secret.txt" },
					},
				],
			},
			{
				capabilities: { artifacts: true, images: false },
				inspectArtifact: (reference) => {
					inspectionCalls++;
					return inspectionFor(reference);
				},
			},
		);
		expect(lexical.ok).toBe(false);
		if (!lexical.ok) {
			expectInputError(lexical.error, "external_path_outside_workspace", "input_workspace_escape");
		}
		expect(inspectionCalls).toBe(0);

		const resolved = await gateCanonicalExternalAgentInputBeforeAcceptance(validInput([workspaceFileArtifact()]), {
			capabilities: { artifacts: true, images: false },
			inspectArtifact: (reference) => ({ ...inspectionFor(reference), workspaceContained: false }),
		});
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expectInputError(resolved.error, "external_path_outside_workspace", "input_workspace_escape");
		}
	});

	it("redacts inspection failure and leaves the caller input unchanged", async () => {
		const mutable = structuredClone(validInput());
		const before = structuredClone(mutable);
		const result = await gateCanonicalExternalAgentInputBeforeAcceptance(mutable, {
			capabilities: { artifacts: true, images: true },
			inspectArtifact: () => {
				throw new Error("C:\\secret\\artifact.bin https://secret.invalid");
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expectInputError(result.error, "external_binding_invalid", "verification_failed");
			expect(result.error.message).not.toContain("secret");
			expect(JSON.stringify(result.error)).not.toContain("secret");
		}
		expect(mutable).toEqual(before);
	});
});
