/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * Note: command execution is async to avoid blocking the TUI. Results are
 * memoized in `command-value-resolver.ts`, shared with the synchronous
 * `model-config-values.ts` resolver so a `!command` runs once per process
 * rather than once per resolver.
 */

import { $envExact } from "@oh-my-pi/pi-utils";
import { resolveCommandAsync } from "./command-value-resolver";

/**
 * The execution layer moved into `command-value-resolver.ts` so the sync and
 * async resolvers share one cache. It stays exported from here because the
 * fd-inheritance suite imports it from this module path — statically, and by
 * file URL in the pathless-PATH probe.
 */
export { runShellCommand } from "./command-value-resolver";

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export async function resolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) return await resolveCommandAsync(config);
	const envValue = $envExact(config);
	return envValue || config;
}


/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveHeaders(
	headers: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = await resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}
