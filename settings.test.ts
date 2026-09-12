import { describe, expect, it } from "vitest";
import { validatePiKbSettings, type ValidationResult } from "./settings.js";

function expectErrors(result: ValidationResult): string[] {
	if (result.ok) throw new Error("expected validation to fail");
	return result.errors;
}

function validConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		"pi-kb": {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [{ name: "dev", notebook: "20240101120000-abc1234" }],
			...overrides,
		},
	};
}

describe("validatePiKbSettings", () => {
	it("accepts a valid config", () => {
		const result = validatePiKbSettings(validConfig());
		expect(result.ok).toBe(true);
	});

	it("accepts absent optional keys, including defaultKBs", () => {
		const result = validatePiKbSettings(validConfig());
		expect(result.ok && result.settings.defaultKBs).toBeUndefined();
		expect(result.ok && result.settings.allowUnattendedWrites).toBeUndefined();
		expect(result.ok && result.settings.writeConfirmTimeout).toBeUndefined();
	});

	it("rejects a missing pi-kb object", () => {
		expect(expectErrors(validatePiKbSettings({}))).toContain(
			"settings.json must contain a 'pi-kb' object",
		);
	});

	it.each([null, [], "pi-kb", 42, { "pi-kb": 42 }])(
		"rejects non-object raw config: %j",
		(raw) => {
			expect(expectErrors(validatePiKbSettings(raw))).toContain(
				"settings.json must contain a 'pi-kb' object",
			);
		},
	);

	it.each([
		["baseUrl", "baseUrl is required and must be a non-empty string"],
		["apiToken", "apiToken is required and must be a non-empty string"],
		["kbs", "kbs is required and must be an array"],
	])("rejects missing %s", (key, expected) => {
		const config = validConfig();
		delete (config["pi-kb"] as Record<string, unknown>)[key];
		expect(expectErrors(validatePiKbSettings(config))).toContain(expected);
	});

	it.each([
		[{ baseUrl: 42 }, "baseUrl is required and must be a non-empty string"],
		[{ apiToken: "" }, "apiToken is required and must be a non-empty string"],
		[{ kbs: "dev" }, "kbs is required and must be an array"],
		[{ defaultKBs: "dev" }, "defaultKBs must be an array of KB name strings"],
		[{ defaultKBs: ["a", 1] }, "defaultKBs must be an array of KB name strings"],
		[{ allowUnattendedWrites: "yes" }, "allowUnattendedWrites must be a boolean"],
		[
			{ writeConfirmTimeout: -1 },
			"writeConfirmTimeout must be a non-negative number (seconds, 0 = wait indefinitely)",
		],
		[
			{ writeConfirmTimeout: 1.5 },
			"writeConfirmTimeout must be a non-negative number (seconds, 0 = wait indefinitely)",
		],
	])("rejects bad type: %j", (overrides, expected) => {
		expect(expectErrors(validatePiKbSettings(validConfig(overrides)))).toContain(
			expected,
		);
	});

	it.each([
		[
			"baseUrl",
			" http://192.168.100.1:6806 ",
			"baseUrl is required and must be a non-empty string",
		],
		[
			"apiToken",
			" token ",
			"apiToken is required and must be a non-empty string",
		],
	])("rejects surrounding whitespace on %s", (key, value, expected) => {
		const config = validConfig();
		(config["pi-kb"] as Record<string, unknown>)[key] = value;
		expect(expectErrors(validatePiKbSettings(config))).toContain(expected);
	});

	it.each([
		[
			"duplicate KB name 'dev'",
			[
				{ name: "dev", notebook: "a" },
				{ name: "dev", notebook: "b" },
			],
		],
		["kbs[0].name must be a non-empty string", [{ name: "", notebook: "a" }]],
		["kbs[0].name must be a non-empty string", [{ name: "  ", notebook: "a" }]],
		[
			"kbs[0].name must be a non-empty string",
			[{ name: " dev ", notebook: "a" }],
		],
		["kbs[0] must be an object with 'name' and 'notebook'", [42]],
		[
			"kbs[0].notebook must be a non-empty string",
			[{ name: "dev", notebook: "" }],
		],
		["kbs[0].notebook must be a non-empty string", [{ name: "dev" }]],
		[
			"KB name 'dev kb' must not contain whitespace or /",
			[{ name: "dev kb", notebook: "a" }],
		],
		[
			"KB name 'dev/kb' must not contain whitespace or /",
			[{ name: "dev/kb", notebook: "a" }],
		],
		[
			"KB name 'all' is reserved for the /kb command",
			[{ name: "all", notebook: "a" }],
		],
	])("rejects %s", (expected, kbs) => {
		expect(expectErrors(validatePiKbSettings(validConfig({ kbs })))).toContain(
			expected,
		);
	});

	it("accepts the §5 special values: writeConfirmTimeout 0 and allowUnattendedWrites true", () => {
		const result = validatePiKbSettings(
			validConfig({ writeConfirmTimeout: 0, allowUnattendedWrites: true }),
		);
		expect(result.ok).toBe(true);
		expect(result.ok && result.settings.writeConfirmTimeout).toBe(0);
		expect(result.ok && result.settings.allowUnattendedWrites).toBe(true);
	});

	it("rejects a defaultKBs entry naming an unknown KB", () => {
		expect(
			expectErrors(validatePiKbSettings(validConfig({ defaultKBs: ["missing"] }))),
		).toContain("defaultKBs entry 'missing' does not match any configured KB");
	});

	it("accepts defaultKBs naming a configured KB and preserves it", () => {
		const result = validatePiKbSettings(validConfig({ defaultKBs: ["dev"] }));
		expect(result.ok).toBe(true);
		expect(result.ok && result.settings.defaultKBs).toEqual(["dev"]);
	});
});
