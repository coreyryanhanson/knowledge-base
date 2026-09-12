// §5 validation step 1 — offline shape validation of the `pi-kb` settings entry.
// No network, no kernel calls (those are validation steps 2–3, M2/M3).

export interface KbEntry {
	name: string;
	notebook: string;
}

export interface PiKbSettings {
	baseUrl: string;
	apiToken: string;
	kbs: KbEntry[];
	defaultKBs?: string[] | undefined;
	allowUnattendedWrites?: boolean | undefined;
	writeConfirmTimeout?: number | undefined;
}

export type ValidationResult =
	| { ok: true; settings: PiKbSettings }
	| { ok: false; errors: string[] };

// The only /kb reserved keyword (§5: no other subcommand surface exists in v1).
const RESERVED_KB_NAMES = new Set(["all"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	// Leading/trailing whitespace is rejected, not trimmed away, so the stored
	// value always matches what was validated (baseUrl/token/notebook are used
	// verbatim downstream).
	return (
		typeof value === "string" && value.trim().length > 0 && value === value.trim()
	);
}

function checkName(name: string, errors: string[]): void {
	if (RESERVED_KB_NAMES.has(name)) {
		errors.push(`KB name '${name}' is reserved for the /kb command`);
	}
	if (/\s/.test(name) || name.includes("/")) {
		errors.push(`KB name '${name}' must not contain whitespace or /`);
	}
}

export function validatePiKbSettings(raw: unknown): ValidationResult {
	if (!isRecord(raw) || !isRecord(raw["pi-kb"])) {
		return { ok: false, errors: ["settings.json must contain a 'pi-kb' object"] };
	}
	const config = raw["pi-kb"];
	const errors: string[] = [];

	if (!isNonEmptyString(config.baseUrl)) {
		errors.push("baseUrl is required and must be a non-empty string");
	}
	if (!isNonEmptyString(config.apiToken)) {
		errors.push("apiToken is required and must be a non-empty string");
	}

	const names = new Set<string>();
	if (Array.isArray(config.kbs)) {
		config.kbs.forEach((entry, i) => {
			if (!isRecord(entry)) {
				errors.push(`kbs[${i}] must be an object with 'name' and 'notebook'`);
				return;
			}
			if (isNonEmptyString(entry.name)) {
				if (names.has(entry.name)) {
					errors.push(`duplicate KB name '${entry.name}'`);
				}
				names.add(entry.name);
				checkName(entry.name, errors);
			} else {
				errors.push(`kbs[${i}].name must be a non-empty string`);
			}
			if (!isNonEmptyString(entry.notebook)) {
				errors.push(`kbs[${i}].notebook must be a non-empty string`);
			}
		});
	} else {
		errors.push("kbs is required and must be an array");
	}

	let defaultKBs: string[] | undefined;
	if (config.defaultKBs !== undefined) {
		if (
			!Array.isArray(config.defaultKBs) ||
			!config.defaultKBs.every((n) => typeof n === "string")
		) {
			errors.push("defaultKBs must be an array of KB name strings");
		} else {
			defaultKBs = config.defaultKBs;
			for (const name of defaultKBs) {
				if (!names.has(name)) {
					errors.push(`defaultKBs entry '${name}' does not match any configured KB`);
				}
			}
		}
	}

	if (
		config.allowUnattendedWrites !== undefined &&
		typeof config.allowUnattendedWrites !== "boolean"
	) {
		errors.push("allowUnattendedWrites must be a boolean");
	}
	if (
		config.writeConfirmTimeout !== undefined &&
		(typeof config.writeConfirmTimeout !== "number" ||
			!Number.isInteger(config.writeConfirmTimeout) ||
			config.writeConfirmTimeout < 0)
	) {
		errors.push(
			"writeConfirmTimeout must be a non-negative number (seconds, 0 = wait indefinitely)",
		);
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		settings: {
			baseUrl: config.baseUrl as string,
			apiToken: config.apiToken as string,
			kbs: config.kbs as KbEntry[],
			defaultKBs,
			allowUnattendedWrites: config.allowUnattendedWrites as boolean | undefined,
			writeConfirmTimeout: config.writeConfirmTimeout as number | undefined,
		},
	};
}
