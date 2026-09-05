/**
 * Execution and process-lifetime memoization for `!command` config values.
 *
 * Both config-value resolvers route through here. `model-config-values.ts`
 * resolves synchronously (the `ModelRegistry` constructor cannot await), while
 * `resolve-config-value.ts` resolves asynchronously for the auth-broker and MCP
 * layers, which run on the first request. While each kept its own private
 * cache, the same command ran once per resolver: a single `!op read` apiKey in
 * models.yml spawned two `op` processes per launch, and on Windows every `op`
 * process costs its own Windows Hello prompt because app-integration
 * authorization is not inherited by sub-processes the way it is on macOS/Linux
 * (https://developer.1password.com/docs/cli/app-integration-security/). One
 * store keyed on the normalized command makes it one execution per process.
 *
 * The sync path cannot await an in-flight async execution, so two resolvers
 * racing the same cold command can still double-run it; whichever settles first
 * fills the cache for the rest of the process.
 */

import { execSync } from "node:child_process";
import { executeShell } from "@oh-my-pi/pi-natives";
import { directoryIsEnterableSync, getProjectDir, logger, ptree } from "@oh-my-pi/pi-utils";

const COMMAND_TIMEOUT_MS = 10_000;
/**
 * Failed resolutions (non-zero exit, empty stdout) are negative-cached with a
 * TTL rather than forever: a transient failure (locked password manager,
 * network hiccup) must not disable the value until process restart, but
 * re-running the command on every resolution would restore the subprocess storm
 * this cache exists to prevent. One probe per TTL window bounds both.
 */
const COMMAND_FAILURE_RETRY_MS = 30_000;

const commandValues = new Map<string, string>();
const commandFailureRetryAt = new Map<string, number>();
/** In-flight async executions, so concurrent resolutions share one subprocess. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

interface PreparedCommand {
	/** The shell command, which doubles as the cache key. */
	command: string;
	/** A cached success or a suppressed failure already answers the resolution. */
	settled: boolean;
	value?: string;
}

/**
 * Forget a command's cached value, negative-cache backoff, and in-flight
 * execution so the next resolution runs it again.
 *
 * Dropping the in-flight entry is what the 401 re-mint path needs: a later
 * async caller must start a fresh execution rather than join one that began
 * before the credential was invalidated.
 */
export function invalidateCommand(valueConfig: string): void {
	const command = valueConfig.slice(1).trim();
	commandValues.delete(command);
	commandFailureRetryAt.delete(command);
	commandInFlight.delete(command);
}

/**
 * Strip the `!` sigil, apply a forced refresh, and report any already-settled
 * result. Deriving the command here rather than at each call site is what keeps
 * the sync and async resolvers from keying past each other and re-running a
 * command the other has already paid for.
 */
function prepare(valueConfig: string, forceRefresh: boolean): PreparedCommand {
	const command = valueConfig.slice(1).trim();
	if (forceRefresh) {
		invalidateCommand(valueConfig);
		return { command, settled: false };
	}
	const cached = commandValues.get(command);
	if (cached !== undefined) return { command, settled: true, value: cached };
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && Date.now() < retryAt) return { command, settled: true };
	return { command, settled: false };
}

/** Record an outcome. Empty output — including a throw or non-zero exit — is a failure. */
function record(command: string, output: string): string | undefined {
	if (output.length === 0) {
		commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
		return undefined;
	}
	commandFailureRetryAt.delete(command);
	commandValues.set(command, output);
	return output;
}

/** Resolve a `!command` value synchronously, reusing any async-resolved result. */
export function resolveCommandSync(valueConfig: string, forceRefresh = false): string | undefined {
	const { command, settled, value } = prepare(valueConfig, forceRefresh);
	if (settled) return value;
	const cwd = getProjectDir();
	// An unenterable cwd makes execSync throw before the command ever runs.
	// Negative-cache it like any other failure so a deleted or permission-denied
	// project dir cannot re-spawn a probe on every resolution.
	if (!directoryIsEnterableSync(cwd)) return record(command, "");
	try {
		const stdout = execSync(command, { cwd, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
		return record(command, stdout.trim());
	} catch (err) {
		// The command may embed credentials inline, and execSync's message can
		// echo the invocation and its output. Log only non-sensitive metadata.
		const code =
			typeof (err as NodeJS.ErrnoException | null)?.code === "string"
				? (err as NodeJS.ErrnoException).code
				: "unknown";
		logger.warn("config: !command value resolution failed", { code });
		return record(command, "");
	}
}

/** Resolve a `!command` value asynchronously, reusing any sync-resolved result. */
export async function resolveCommandAsync(valueConfig: string): Promise<string | undefined> {
	const { command, settled, value } = prepare(valueConfig, false);
	if (settled) return value;

	const existing = commandInFlight.get(command);
	if (existing) return await existing;

	const execution = runShellCommand(command, COMMAND_TIMEOUT_MS)
		.then(output => record(command, output ?? ""))
		.finally(() => {
			commandInFlight.delete(command);
		});
	commandInFlight.set(command, execution);
	return await execution;
}

/**
 * Run one `!command` config-value resolution and capture stdout.
 *
 * Exported for testing (timeout and tree-kill semantics).
 *
 * On POSIX, ptree spawns through Bun with piped-only stdio, so descriptors
 * this process holds open — e.g. a credential a launcher passed us on a
 * private fd — cannot cross into the command. On timeout it hard-kills the
 * whole descendant tree and only reports once that kill has completed, so a
 * credential helper that forked background work cannot outlive its budget;
 * stderr is drained to a truncated tail rather than mixed into the captured
 * value.
 *
 * Windows keeps the original natives Brush shell: existing `!command` values
 * depend on its POSIX-style grammar, and piped-only stdio changes nothing
 * there — child handle inheritance is governed by the CreateProcess
 * inheritable-handle set, not by which stdio streams are wired, so the
 * measured POSIX fd-inheritance leak has no Windows equivalent this switch
 * would close.
 */
export async function runShellCommand(command: string, timeoutMs: number): Promise<string | undefined> {
	if (process.platform === "win32") {
		try {
			let output = "";
			const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
				if (!err) {
					output += chunk;
				}
			});
			if (result.timedOut || result.exitCode !== 0) {
				return undefined;
			}
			const trimmed = output.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		// Absolute OS shell, not a PATH-resolved name: a launcher may hand omp a
		// minimal tool-only PATH (same shape as execSync's default shell).
		const result = await ptree.exec(["/bin/sh", "-c", command], {
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			// POSIX process-group isolation keeps double-forked/reparented
			// descendants reachable after they leave the shell's PID tree.
			detached: true,
			// Linux child-subreaper supervision retains workers that create a new
			// session and outlive the intermediate process that launched them.
			subreaper: process.platform === "linux",
		});
		// An aborted result can still carry a real exit code (the command may
		// exit zero in the window between the timeout firing and the kill landing)
		// — timed-out output is never a resolved credential.
		if (!result.ok || result.exitError?.aborted) return undefined;
		const trimmed = result.stdout.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}
