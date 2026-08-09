export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.AOS_AGENT_EXPERIMENTAL === "1";
}
