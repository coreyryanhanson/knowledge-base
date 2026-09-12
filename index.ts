import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Milestone 1 scaffold: loads in a real session, registers zero tools.
// Kernel probe, version gate, tools, and /kb all arrive in M2+.
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		// M2: settings load + validation, eager version probe, verdict caching.
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// M2+: session-scoped resource cleanup (currently none).
	});
}
