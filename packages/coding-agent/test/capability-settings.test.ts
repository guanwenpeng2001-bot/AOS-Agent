import { describe, expect, it } from "vitest";
import {
	buildCapabilitySettings,
	type CapabilitySettings,
	CapabilitySettingsError,
	type CapabilitySettingsErrorCode,
	type CapabilitySettingsInput,
	createCapabilitySettingsView,
	createMcpServerCapabilityCandidate,
} from "../src/core/capability-settings.ts";
import {
	buildCapabilityCatalog,
	createCapabilityId,
	resolveCapabilityBinding,
} from "../src/core/capability-registry.ts";

function build(options: {
	global?: CapabilitySettingsInput;
	project?: CapabilitySettingsInput;
	projectTrusted?: boolean;
}): CapabilitySettings {
	return buildCapabilitySettings({
		global: options.global ?? {},
		...(options.project !== undefined ? { project: options.project } : {}),
		projectTrusted: options.projectTrusted ?? true,
	});
}

function errorCode(fn: () => unknown): CapabilitySettingsErrorCode {
	try {
		fn();
	} catch (error) {
		if (error instanceof CapabilitySettingsError) {
			return error.code;
		}
		throw error;
	}
	throw new Error("expected a CapabilitySettingsError");
}

const STDIO_SERVER = {
	transport: "stdio",
	command: "node",
	args: ["server.js"],
	env: ["DOCS_TOKEN"],
};

const HTTP_SERVER = {
	transport: "streamable-http",
	url: "https://mcp.example.invalid/mcp",
	headersFromEnv: [{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" }],
};

const PROFILE_CONFIG = {
	defaultProfile: "default",
	profiles: {
		default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] },
	},
};

describe("buildCapabilitySettings basics", () => {
	it("synthesizes a safe empty default profile when no capability config exists", () => {
		const settings = build({});
		expect(settings.defaultProfile).toBe("default");
		expect(settings.profiles.default).toEqual({ rules: [] });
		expect(settings.mcpServers).toEqual([]);
	});

	it("parses capabilities and mcp config into validated structures", () => {
		const settings = build({
			global: { capabilities: PROFILE_CONFIG, mcp: { servers: { docs: STDIO_SERVER } } },
		});
		expect(settings.defaultProfile).toBe("default");
		expect(settings.profiles.default.rules).toHaveLength(1);
		expect(settings.mcpServers).toHaveLength(1);
		expect(settings.mcpServers[0]).toMatchObject({
			id: "docs",
			scope: "global",
			trusted: true,
			server: { transport: "stdio", command: "node" },
		});
	});

	it("derives a source identity for global servers", () => {
		const settings = build({ global: { mcp: { servers: { docs: HTTP_SERVER } } } });
		const diagnostic = settings.mcpServers[0];
		expect(diagnostic.source.source).toBe("mcp:global");
		expect(diagnostic.source.scope).toBe("user");
	});

	it("throws when the resolved defaultProfile is not defined", () => {
		expect(
			errorCode(() =>
				build({ global: { capabilities: { defaultProfile: "nope", profiles: PROFILE_CONFIG.profiles } } }),
			),
		).toBe("capability_settings_profile_not_found");
	});

	it("throws when profiles are defined but the implied default profile is missing", () => {
		expect(
			errorCode(() => build({ global: { capabilities: { profiles: { dev: PROFILE_CONFIG.profiles.default } } } })),
		).toBe("capability_settings_profile_not_found");
	});

	it("rejects a non-string defaultProfile", () => {
		expect(errorCode(() => build({ global: { capabilities: { defaultProfile: 42 } } }))).toBe(
			"capability_settings_invalid_profile",
		);
	});

	it("rejects unknown capabilities fields", () => {
		expect(errorCode(() => build({ global: { capabilities: { bogus: true } } }))).toBe(
			"capability_settings_invalid_profile",
		);
	});

	it("rejects a non-object capabilities value", () => {
		expect(errorCode(() => build({ global: { capabilities: "not-an-object" } }))).toBe(
			"capability_settings_invalid_profile",
		);
	});
});

describe("profile selector validation", () => {
	function withRule(rule: unknown): CapabilitySettingsInput {
		return { capabilities: { defaultProfile: "default", profiles: { default: { rules: [rule] } } } };
	}

	it("rejects an empty selector", () => {
		expect(errorCode(() => build({ global: withRule({ selector: {}, action: "allow" }) }))).toBe(
			"capability_settings_invalid_selector",
		);
	});

	it("rejects unknown selector fields", () => {
		expect(
			errorCode(() => build({ global: withRule({ selector: { kind: "builtin_tool", bogus: 1 }, action: "allow" }) })),
		).toBe("capability_settings_invalid_selector");
	});

	it("rejects an invalid capability kind", () => {
		expect(
			errorCode(() => build({ global: withRule({ selector: { kind: "made_up" }, action: "allow" }) })),
		).toBe("capability_settings_invalid_selector");
	});

	it("rejects an invalid scope", () => {
		expect(
			errorCode(() => build({ global: withRule({ selector: { scope: "everywhere" }, action: "ask" }) })),
		).toBe("capability_settings_invalid_selector");
	});

	it("rejects an empty string selector field", () => {
		expect(
			errorCode(() => build({ global: withRule({ selector: { id: "" }, action: "allow" }) })),
		).toBe("capability_settings_invalid_selector");
	});

	it("rejects a rule with a missing selector", () => {
		expect(errorCode(() => build({ global: withRule({ action: "allow" }) }))).toBe(
			"capability_settings_invalid_selector",
		);
	});

	it("rejects a rule with a missing action", () => {
		expect(errorCode(() => build({ global: withRule({ selector: { kind: "skill" } }) }))).toBe(
			"capability_settings_invalid_selector",
		);
	});

	it("rejects an invalid action", () => {
		expect(
			errorCode(() => build({ global: withRule({ selector: { kind: "skill" }, action: "maybe" }) })),
		).toBe("capability_settings_invalid_selector");
	});

	it("rejects unknown rule fields", () => {
		expect(
			errorCode(() => build({ global: withRule({ selector: { kind: "skill" }, action: "allow", extra: true }) })),
		).toBe("capability_settings_invalid_selector");
	});

	it("rejects a profile missing rules", () => {
		expect(
			errorCode(() =>
				build({ global: { capabilities: { defaultProfile: "default", profiles: { default: {} } } } }),
			),
		).toBe("capability_settings_invalid_profile");
	});

	it("rejects unknown profile fields", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						capabilities: {
							defaultProfile: "default",
							profiles: { default: { rules: [], extra: true } },
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_profile");
	});

	it("accepts a full multi-field selector", () => {
		const settings = build({
			global: {
				capabilities: {
					defaultProfile: "default",
					profiles: {
						default: {
							rules: [
								{
									selector: { kind: "mcp_tool", mcpServerId: "docs", scope: "project", parentId: "server" },
									action: "deny",
								},
							],
						},
					},
				},
			},
		});
		expect(settings.profiles.default.rules[0].selector).toEqual({
			kind: "mcp_tool",
			mcpServerId: "docs",
			scope: "project",
			parentId: "server",
		});
	});
});

describe("MCP server id validation", () => {
	it("rejects an empty server id", () => {
		expect(errorCode(() => build({ global: { mcp: { servers: { "": STDIO_SERVER } } } }))).toBe(
			"capability_settings_invalid_server_id",
		);
	});

	it("rejects a whitespace-only server id", () => {
		expect(errorCode(() => build({ global: { mcp: { servers: { "   ": STDIO_SERVER } } } }))).toBe(
			"capability_settings_invalid_server_id",
		);
	});

	it("rejects a double-underscore server id", () => {
		expect(errorCode(() => build({ global: { mcp: { servers: { "docs__v2": STDIO_SERVER } } } }))).toBe(
			"capability_settings_invalid_server_id",
		);
	});

	it("rejects a server id with surrounding whitespace", () => {
		expect(errorCode(() => build({ global: { mcp: { servers: { " docs ": STDIO_SERVER } } } }))).toBe(
			"capability_settings_invalid_server_id",
		);
	});

	it("rejects a server id with a control character", () => {
		expect(errorCode(() => build({ global: { mcp: { servers: { "doc\x00s": STDIO_SERVER } } } }))).toBe(
			"capability_settings_invalid_server_id",
		);
	});

	it("accepts common server ids", () => {
		const settings = build({
			global: {
				mcp: {
					servers: {
						docs: STDIO_SERVER,
						"issue-tracker": HTTP_SERVER,
						"a.b_c-1": STDIO_SERVER,
					},
				},
			},
		});
		expect(settings.mcpServers.map((server) => server.id)).toEqual(["docs", "issue-tracker", "a.b_c-1"]);
	});
});

describe("cross-scope duplicate server ids", () => {
	it("rejects a project server id that duplicates a global id when trusted", () => {
		expect(
			errorCode(() =>
				build({
					global: { mcp: { servers: { docs: STDIO_SERVER } } },
					project: { mcp: { servers: { docs: HTTP_SERVER } } },
					projectTrusted: true,
				}),
			),
		).toBe("capability_settings_duplicate_server_id");
	});

	it("rejects a project server id that duplicates a global id regardless of trust", () => {
		expect(
			errorCode(() =>
				build({
					global: { mcp: { servers: { docs: STDIO_SERVER } } },
					project: { mcp: { servers: { docs: HTTP_SERVER } } },
					projectTrusted: false,
				}),
			),
		).toBe("capability_settings_duplicate_server_id");
	});
});

describe("MCP server config validation", () => {
	it("rejects a server missing transport", () => {
		expect(errorCode(() => build({ global: { mcp: { servers: { docs: { command: "node" } } } } }))).toBe(
			"capability_settings_invalid_server",
		);
	});

	it("rejects an unknown transport", () => {
		expect(
			errorCode(() => build({ global: { mcp: { servers: { docs: { transport: "sse", url: "https://x" } } } } })),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects a stdio server without a command", () => {
		expect(
			errorCode(() => build({ global: { mcp: { servers: { docs: { transport: "stdio" } } } } })),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects an empty command", () => {
		expect(
			errorCode(() => build({ global: { mcp: { servers: { docs: { transport: "stdio", command: "  " } } } } })),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects a non-string command", () => {
		expect(
			errorCode(() => build({ global: { mcp: { servers: { docs: { transport: "stdio", command: 42 } } } } })),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects stdio servers carrying http-only fields", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						mcp: {
							servers: {
								docs: {
									transport: "stdio",
									command: "node",
									url: "https://mcp.example.invalid/mcp",
								},
							},
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects streamable-http servers without a url", () => {
		expect(
			errorCode(() => build({ global: { mcp: { servers: { docs: { transport: "streamable-http" } } } } })),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects streamable-http servers carrying stdio-only fields", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						mcp: {
							servers: {
								docs: { transport: "streamable-http", url: "https://x", command: "node" },
							},
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects unknown server fields", () => {
		expect(
			errorCode(() =>
				build({ global: { mcp: { servers: { docs: { ...STDIO_SERVER, cwd: "/tmp" } } } } }),
			),
		).toBe("capability_settings_invalid_server");
	});

	it("rejects non-array args and env", () => {
		expect(
			errorCode(() =>
				build({ global: { mcp: { servers: { docs: { ...STDIO_SERVER, args: "server.js" } } } } }),
			),
		).toBe("capability_settings_invalid_server");
		expect(
			errorCode(() =>
				build({ global: { mcp: { servers: { docs: { ...STDIO_SERVER, env: "DOCS_TOKEN" } } } } }),
			),
		).toBe("capability_settings_invalid_env");
	});
});

describe("MCP URL validation", () => {
	function withUrl(url: string): CapabilitySettingsInput {
		return { mcp: { servers: { docs: { transport: "streamable-http", url } } } };
	}

	it("accepts a valid https URL", () => {
		const settings = build({ global: withUrl("https://mcp.example.invalid/mcp") });
		expect(settings.mcpServers[0].server).toMatchObject({ url: "https://mcp.example.invalid/mcp" });
	});

	it("accepts a benign query string", () => {
		const settings = build({ global: withUrl("https://mcp.example.invalid/mcp?mode=full") });
		expect(settings.mcpServers[0].server).toMatchObject({ url: "https://mcp.example.invalid/mcp?mode=full" });
	});

	it("rejects a non-http scheme", () => {
		expect(errorCode(() => build({ global: withUrl("ftp://host/mcp") }))).toBe("capability_settings_invalid_url");
	});

	it("rejects a malformed URL", () => {
		expect(errorCode(() => build({ global: withUrl("not a url") }))).toBe("capability_settings_invalid_url");
	});

	it("rejects userinfo", () => {
		expect(errorCode(() => build({ global: withUrl("https://user:pass@host/mcp") }))).toBe(
			"capability_settings_invalid_url",
		);
	});

	it("rejects credential query parameters", () => {
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?token=abc") }))).toBe(
			"capability_settings_invalid_url",
		);
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?api_key=xyz") }))).toBe(
			"capability_settings_invalid_url",
		);
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?X-Api-Key=abc") }))).toBe(
			"capability_settings_invalid_url",
		);
	});

	it("rejects a bare key query parameter as credential-bearing", () => {
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?key=abc") }))).toBe(
			"capability_settings_invalid_url",
		);
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?x-key=abc") }))).toBe(
			"capability_settings_invalid_url",
		);
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?client_key=abc") }))).toBe(
			"capability_settings_invalid_url",
		);
	});

	it("rejects a literal token in a query value", () => {
		expect(errorCode(() => build({ global: withUrl("https://host/mcp?cb=sk-abc1234567890") }))).toBe(
			"capability_settings_invalid_url",
		);
	});
});

describe("MCP env and header validation", () => {
	it("accepts valid env names", () => {
		const settings = build({
			global: { mcp: { servers: { docs: { transport: "stdio", command: "node", env: ["MY_VAR_2", "_PRIVATE"] } } } },
		});
		expect(settings.mcpServers[0].server).toMatchObject({ env: ["MY_VAR_2", "_PRIVATE"] });
	});

	it("rejects an env entry that embeds a value", () => {
		expect(
			errorCode(() =>
				build({ global: { mcp: { servers: { docs: { ...STDIO_SERVER, env: ["DOCS_TOKEN=sk-super-secret"] } } } } }),
			),
		).toBe("capability_settings_invalid_env");
	});

	it("rejects an env name starting with a digit", () => {
		expect(
			errorCode(() => build({ global: { mcp: { servers: { docs: { ...STDIO_SERVER, env: ["1DOCS"] } } } } })),
		).toBe("capability_settings_invalid_env");
	});

	it("accepts valid headersFromEnv", () => {
		const settings = build({ global: { mcp: { servers: { docs: HTTP_SERVER } } } });
		expect(settings.mcpServers[0].server).toMatchObject({
			headersFromEnv: [{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" }],
		});
	});

	it("rejects an invalid header name", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						mcp: {
							servers: {
								docs: {
									transport: "streamable-http",
									url: "https://host/mcp",
									headersFromEnv: [{ name: "Bad Header", valueFromEnv: "TOKEN" }],
								},
							},
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_header");
	});

	it("rejects an invalid valueFromEnv", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						mcp: {
							servers: {
								docs: {
									transport: "streamable-http",
									url: "https://host/mcp",
									headersFromEnv: [{ name: "Authorization", valueFromEnv: "Bearer sk-abc1234567890" }],
								},
							},
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_header");
	});

	it("rejects duplicate header names", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						mcp: {
							servers: {
								docs: {
									transport: "streamable-http",
									url: "https://host/mcp",
									headersFromEnv: [
										{ name: "Authorization", valueFromEnv: "TOKEN_A" },
										{ name: "authorization", valueFromEnv: "TOKEN_B" },
									],
								},
							},
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_header");
	});

	it("rejects unknown header fields", () => {
		expect(
			errorCode(() =>
				build({
					global: {
						mcp: {
							servers: {
								docs: {
									transport: "streamable-http",
									url: "https://host/mcp",
									headersFromEnv: [{ name: "Authorization", valueFromEnv: "TOKEN", value: "sk-secret" }],
								},
							},
						},
					},
				}),
			),
		).toBe("capability_settings_invalid_header");
	});
});

describe("MCP argv secret validation", () => {
	function withArgs(args: string[]): CapabilitySettingsInput {
		return { mcp: { servers: { docs: { transport: "stdio", command: "node", args } } } };
	}

	it("permits benign arguments", () => {
		const settings = build({
			global: withArgs(["server.js", "--port=3000", "--debug", "--model=claude-sonnet", "start"]),
		});
		expect(settings.mcpServers[0].server).toMatchObject({
			args: ["server.js", "--port=3000", "--debug", "--model=claude-sonnet", "start"],
		});
	});

	it("permits a non-secret flag with an env-name value", () => {
		const settings = build({ global: withArgs(["--config", "PATH_TO_CONFIG"]) });
		expect(settings.mcpServers[0].server).toMatchObject({ args: ["--config", "PATH_TO_CONFIG"] });
	});

	it("rejects a literal token argument", () => {
		expect(errorCode(() => build({ global: withArgs(["server.js", "sk-abc1234567890"]) }))).toBe(
			"capability_settings_secret_argument",
		);
	});

	it("rejects a GitHub token argument", () => {
		expect(errorCode(() => build({ global: withArgs(["ghp_abcdefghijklmnopqrstuvwxyz"]) }))).toBe(
			"capability_settings_secret_argument",
		);
	});

	it("rejects a JWT argument", () => {
		expect(
			errorCode(() =>
				build({
					global: withArgs([
						"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
					]),
				}),
			),
		).toBe("capability_settings_secret_argument");
	});

	it("rejects a credential flag with an inline value", () => {
		expect(errorCode(() => build({ global: withArgs(["--api-key=sk-abc1234567890"]) }))).toBe(
			"capability_settings_secret_argument",
		);
		expect(errorCode(() => build({ global: withArgs(["--token=abc"]) }))).toBe(
			"capability_settings_secret_argument",
		);
	});

	it("rejects a credential flag followed by a value", () => {
		expect(errorCode(() => build({ global: withArgs(["--password", "hunter2"]) }))).toBe(
			"capability_settings_secret_argument",
		);
		expect(errorCode(() => build({ global: withArgs(["--token", "abc123"]) }))).toBe(
			"capability_settings_secret_argument",
		);
	});

	it("rejects a literal header or cookie argument", () => {
		expect(
			errorCode(() => build({ global: withArgs(["Authorization: Bearer abcdef123456"]) })),
		).toBe("capability_settings_secret_argument");
		expect(
			errorCode(() => build({ global: withArgs(["Cookie: session=abcdef123456"]) })),
		).toBe("capability_settings_secret_argument");
	});

	it("tolerates a bare credential flag with no value", () => {
		const settings = build({ global: withArgs(["--token"]) });
		expect(settings.mcpServers[0].server).toMatchObject({ args: ["--token"] });
	});
});

describe("trusted project merge", () => {
	it("merges project profiles and defaultProfile over global", () => {
		const settings = build({
			global: {
				capabilities: {
					defaultProfile: "default",
					profiles: { default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] } },
				},
			},
			project: {
				capabilities: {
					defaultProfile: "strict",
					profiles: {
						strict: { rules: [{ selector: { kind: "mcp_server" }, action: "deny" }] },
					},
				},
			},
			projectTrusted: true,
		});
		expect(settings.defaultProfile).toBe("strict");
		expect(Object.keys(settings.profiles).sort()).toEqual(["default", "strict"]);
	});

	it("lets a trusted project replace a same-named global profile", () => {
		const settings = build({
			global: {
				capabilities: {
					defaultProfile: "default",
					profiles: { default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] } },
				},
			},
			project: {
				capabilities: {
					profiles: { default: { rules: [{ selector: { kind: "builtin_tool" }, action: "deny" }] } },
				},
			},
			projectTrusted: true,
		});
		expect(settings.profiles.default.rules).toEqual([{ selector: { kind: "builtin_tool" }, action: "deny" }]);
	});

	it("marks trusted project servers as trusted project-scope diagnostics", () => {
		const settings = build({
			project: { mcp: { servers: { docs: STDIO_SERVER } } },
			projectTrusted: true,
		});
		expect(settings.mcpServers).toHaveLength(1);
		expect(settings.mcpServers[0]).toMatchObject({ id: "docs", scope: "project", trusted: true });
		expect(settings.mcpServers[0].source.source).toBe("mcp:project");
		expect(settings.mcpServers[0].source.scope).toBe("project");
	});
});

describe("untrusted project isolation", () => {
	it("ignores project profiles and defaultProfile", () => {
		const settings = build({
			global: {
				capabilities: {
					defaultProfile: "default",
					profiles: { default: { rules: [{ selector: { kind: "builtin_tool" }, action: "allow" }] } },
				},
			},
			project: {
				capabilities: {
					defaultProfile: "evil",
					profiles: {
						evil: { rules: [{ selector: { kind: "mcp_server" }, action: "allow" }] },
					},
				},
			},
			projectTrusted: false,
		});
		expect(settings.defaultProfile).toBe("default");
		expect(settings.profiles.evil).toBeUndefined();
		expect(settings.profiles.default.rules).toEqual([{ selector: { kind: "builtin_tool" }, action: "allow" }]);
	});

	it("keeps untrusted project MCP servers as diagnostics marked untrusted", () => {
		const settings = build({
			project: { mcp: { servers: { docs: STDIO_SERVER } } },
			projectTrusted: false,
		});
		expect(settings.mcpServers).toHaveLength(1);
		expect(settings.mcpServers[0]).toMatchObject({ id: "docs", scope: "project", trusted: false });
		expect(settings.mcpServers[0].source.scope).toBe("project");
	});

	it("ignores project profiles even when the project mcp config is otherwise present", () => {
		const settings = build({
			global: { capabilities: PROFILE_CONFIG },
			project: {
				capabilities: {
					defaultProfile: "proj",
					profiles: { proj: { rules: [{ selector: { kind: "mcp_server" }, action: "allow" }] } },
				},
				mcp: { servers: { docs: HTTP_SERVER } },
			},
			projectTrusted: false,
		});
		expect(settings.defaultProfile).toBe("default");
		expect(settings.profiles.proj).toBeUndefined();
		expect(settings.mcpServers).toHaveLength(1);
		expect(settings.mcpServers[0].trusted).toBe(false);
	});
});

describe("redacted views", () => {
	it("exposes only env/header names and redacts URL query from the view", () => {
		const settings = build({
			global: {
				mcp: {
					servers: {
						docs: {
							transport: "streamable-http",
							url: "https://mcp.example.invalid/mcp?mode=full",
							headersFromEnv: [{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" }],
						},
					},
				},
			},
		});
		const view = createCapabilitySettingsView(settings);
		expect(view.mcpServers[0].url).toBe("https://mcp.example.invalid/mcp");
		expect(view.mcpServers[0].headersFromEnv).toEqual([
			{ name: "Authorization", valueFromEnv: "ISSUE_TRACKER_TOKEN" },
		]);
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("Bearer");
		expect(serialized).not.toContain("sk-");
		expect(serialized).not.toContain("user:pass");
	});

	it("keeps stdio env names (never values) in the view", () => {
		const settings = build({ global: { mcp: { servers: { docs: STDIO_SERVER } } } });
		const view = createCapabilitySettingsView(settings);
		expect(view.mcpServers[0]).toMatchObject({
			id: "docs",
			scope: "global",
			trusted: true,
			transport: "stdio",
			command: "node",
			args: ["server.js"],
			env: ["DOCS_TOKEN"],
		});
	});
});

describe("Registry denial integration", () => {
	it("denies an untrusted project MCP server and its tools even when the profile allows them", () => {
		const settings = build({
			project: { mcp: { servers: { docs: HTTP_SERVER } } },
			projectTrusted: false,
		});
		const server = settings.mcpServers[0];
		expect(server.trusted).toBe(false);

		const serverCandidate = createMcpServerCapabilityCandidate(server);
		const serverId = createCapabilityId("mcp_server", serverCandidate.sourceIdentity, "docs");
		const catalog = buildCapabilityCatalog({
			candidates: [
				serverCandidate,
				{
					kind: "mcp_tool",
					name: "list",
					localName: "list",
					mcpServerId: "docs",
					parentId: serverId,
					sourceIdentity: serverCandidate.sourceIdentity,
					source: server.source,
				},
			],
		});

		const binding = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: {
				default: {
					rules: [
						{ selector: { kind: "mcp_server" }, action: "allow" },
						{ selector: { kind: "mcp_tool" }, action: "allow" },
					],
				},
			},
		});
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 2 });
		expect(binding.descriptors).toHaveLength(0);
		expect(binding.toolAllowlist).toEqual([]);
	});

	it("allows a global MCP server and its tools when the profile allows them", () => {
		const settings = build({ global: { mcp: { servers: { docs: HTTP_SERVER } } } });
		const server = settings.mcpServers[0];
		expect(server.trusted).toBe(true);

		const serverCandidate = createMcpServerCapabilityCandidate(server);
		const serverId = createCapabilityId("mcp_server", serverCandidate.sourceIdentity, "docs");
		const catalog = buildCapabilityCatalog({
			candidates: [
				serverCandidate,
				{
					kind: "mcp_tool",
					name: "list",
					localName: "list",
					mcpServerId: "docs",
					parentId: serverId,
					sourceIdentity: serverCandidate.sourceIdentity,
					source: server.source,
				},
			],
		});

		const binding = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: {
				default: {
					rules: [
						{ selector: { kind: "mcp_server" }, action: "allow" },
						{ selector: { kind: "mcp_tool" }, action: "allow" },
					],
				},
			},
		});
		expect(binding.decisionSummary).toEqual({ allowed: 2, awaitingApproval: 0, denied: 0 });
		expect(binding.toolAllowlist).toEqual(["mcp__docs__list"]);
	});

	it("keeps an untrusted project server out of the binding under the safe default profile", () => {
		const settings = build({
			project: { mcp: { servers: { docs: STDIO_SERVER } } },
			projectTrusted: false,
		});
		const serverCandidate = createMcpServerCapabilityCandidate(settings.mcpServers[0]);
		const serverId = createCapabilityId("mcp_server", serverCandidate.sourceIdentity, "docs");
		const catalog = buildCapabilityCatalog({
			candidates: [
				serverCandidate,
				{
					kind: "mcp_tool",
					name: "list",
					mcpServerId: "docs",
					parentId: serverId,
					sourceIdentity: serverCandidate.sourceIdentity,
					source: settings.mcpServers[0].source,
				},
			],
		});
		const binding = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: { default: { rules: [] } },
		});
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 2 });
	});
});
