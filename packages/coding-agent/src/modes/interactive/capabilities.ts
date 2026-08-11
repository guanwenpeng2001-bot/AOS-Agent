/**
 * Rendering for the interactive `/capabilities` command.
 *
 * Everything here is derived from the public Session capability surface only:
 * `session.inspectCapabilityCatalog()`, `session.getActiveCapabilityBinding()`,
 * `session.getActiveCapabilityProfile()`, and `session.approveCapability()`.
 * No lifecycle, MCP transport, or binding internals are surfaced.
 */
import {
	CapabilityError,
	type CapabilityCatalogView,
	type CapabilityDescriptorView,
} from "../../core/capability-registry.ts";
import { theme } from "./theme/theme.ts";

// Stable, redacted capability view types exposed by the Session capability
// surface. These are type-only: consumers can reference the redacted catalog,
// descriptor, and binding views without raw config or binding internals.
export type { CapabilityBindingView, CapabilityCatalogView, CapabilityDescriptorView } from "../../core/capability-registry.ts";

/** The three supported `/capabilities` command forms. */
export function formatCapabilitiesUsage(): string {
	return ["/capabilities", "/capabilities inspect <id>", "/capabilities approve <id>"].join("\n");
}

/**
 * Render the full redacted capability catalog for the bare `/capabilities`
 * command. `selectedDescriptorIds` marks descriptors in the active binding.
 */
export function formatCapabilityCatalog(
	catalog: CapabilityCatalogView,
	selectedDescriptorIds?: ReadonlySet<string>,
	discoveryNote?: string,
): string {
	const descriptors = catalog.descriptors;
	let info = `${theme.bold(`Capabilities (${descriptors.length})`)}\n`;
	if (descriptors.length === 0) {
		info += `\n${theme.fg("dim", "No capabilities discovered yet.")}\n`;
	} else {
		for (const descriptor of descriptors) {
			const selected = selectedDescriptorIds?.has(descriptor.id) ?? false;
			const selectedLabel = selected ? theme.fg("success", " selected") : "";
			info += `\n${descriptor.decision.padEnd(6)} ${descriptor.kind.padEnd(14)} ${descriptor.availability.padEnd(12)} ${descriptor.name}${selectedLabel}\n`;
			info += `  ${theme.fg("dim", descriptor.id)}  ${theme.fg("dim", descriptor.source.source)} (${descriptor.source.scope}, ${descriptor.source.origin})\n`;
			info += `  ${theme.fg("dim", `revision ${descriptor.revision}`)}\n`;
		}
		info += `\n${theme.fg("dim", "Use /capabilities inspect <id> for details or /capabilities approve <id> to approve for this session.")}\n`;
	}
	if (discoveryNote !== undefined) {
		info += `\n${theme.fg("warning", `Discovery: ${discoveryNote}`)}\n`;
	}
	return info;
}

/** Render one descriptor for `/capabilities inspect <id>`. */
export function formatCapabilityDescriptor(
	descriptor: CapabilityDescriptorView,
	options: { profile?: string; bindingId?: string; selected?: boolean } = {},
): string {
	const { source } = descriptor;
	let info = `${theme.bold(`Capability: ${descriptor.name}`)}\n\n`;
	info += `${theme.fg("dim", "Id:")} ${descriptor.id}\n`;
	info += `${theme.fg("dim", "Kind:")} ${descriptor.kind}\n`;
	info += `${theme.fg("dim", "Profile rule:")} ${descriptor.decision}\n`;
	info += `${theme.fg("dim", "Availability:")} ${descriptor.availability}\n`;
	info += `${theme.fg("dim", "Trusted:")} ${descriptor.trusted ? "yes" : "no"}\n`;
	info += `${theme.fg("dim", "Selected:")} ${options.selected ? "yes" : "no"}\n`;
	if (options.profile !== undefined) {
		info += `${theme.fg("dim", "Profile:")} ${options.profile}\n`;
	}
	if (options.bindingId !== undefined) {
		info += `${theme.fg("dim", "Binding:")} ${options.bindingId}\n`;
	}
	if (descriptor.exposedToolName !== undefined) {
		info += `${theme.fg("dim", "Exposed tool:")} ${descriptor.exposedToolName}\n`;
	}
	if (descriptor.mcpServerId !== undefined) {
		info += `${theme.fg("dim", "MCP server:")} ${descriptor.mcpServerId}\n`;
	}
	if (descriptor.parentId !== undefined) {
		info += `${theme.fg("dim", "Parent:")} ${descriptor.parentId}\n`;
	}
	info += `${theme.fg("dim", "Source:")} ${source.source} (${source.scope}, ${source.origin})\n`;
	info += `${theme.fg("dim", "Revision:")} ${descriptor.revision}\n`;
	return info;
}

/** Confirm a session-local approval for `/capabilities approve <id>`. */
export function formatCapabilityApproval(descriptorId: string): string {
	return (
		`${theme.bold("Approved")} ${descriptorId} for this session\n` +
		`${theme.fg("dim", "The approval is session-local and never overrides a deny from the active profile.")}`
	);
}

/**
 * Format a thrown error from the Session capability API. Only `CapabilityError`
 * codes and their redacted messages are shown; anything else is a generic
 * capability failure with no arbitrary message echo.
 */
export function formatCapabilitiesError(error: unknown): string {
	if (error instanceof CapabilityError) {
		return `${theme.fg("error", error.code)}: ${error.message}`;
	}
	return theme.fg("error", "Capability failure.");
}
