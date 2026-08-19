import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";


export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		},
		resolve: {
			alias: [{
				find: /^@aos-agent\/protocol$/,
				replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			}],
		},
	}),
);
