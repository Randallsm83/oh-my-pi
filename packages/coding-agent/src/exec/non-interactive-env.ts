import { $which } from "@oh-my-pi/pi-utils";

/** Portable command that rejects credential prompts without assuming an FHS layout. */
export const REJECT_PROMPT_COMMAND = $which("false") ?? "false";

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	// Disable pagers so commands don't block on interactive views.
	PAGER: "cat",
	GIT_PAGER: "cat",
	MANPAGER: "cat",
	SYSTEMD_PAGER: "cat",
	BAT_PAGER: "cat",
	DELTA_PAGER: "cat",
	GH_PAGER: "cat",
	GLAB_PAGER: "cat",
	PSQL_PAGER: "cat",
	MYSQL_PAGER: "cat",
	AWS_PAGER: "",
	HOMEBREW_PAGER: "cat",
	LESS: "FRX",
	// Disable terminal features that can block the process.
	TERM: "dumb",
	NO_COLOR: "1",
	PYTHONUNBUFFERED: "1",
	// Disable editor and terminal credential prompts.
	GIT_EDITOR: "true",
	VISUAL: "true",
	EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
	CI: "true",
	AGENT: "1",
	// Package manager defaults for unattended execution.
	npm_config_yes: "true",
	npm_config_update_notifier: "false",
	npm_config_fund: "false",
	npm_config_audit: "false",
	npm_config_progress: "false",
	PNPM_DISABLE_SELF_UPDATE_CHECK: "true",
	PNPM_UPDATE_NOTIFIER: "false",
	YARN_ENABLE_TELEMETRY: "0",
	YARN_ENABLE_PROGRESS_BARS: "0",
	// Cross-language/tooling non-interactive defaults.
	CARGO_TERM_PROGRESS_WHEN: "never",
	DEBIAN_FRONTEND: "noninteractive",
	PIP_NO_INPUT: "1",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	TF_INPUT: "0",
	TF_IN_AUTOMATION: "1",
	GH_PROMPT_DISABLED: "1",
	COMPOSER_NO_INTERACTION: "1",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
};

/**
 * Overrides that ask color-aware tools to emit SGR even though stdout is a
 * pipe. Covers the two conventions with broad support: `CLICOLOR_FORCE` (Rust
 * `clicolors`, delta, BSD-style tools) and `FORCE_COLOR` (Node/chalk, cargo).
 * Tools that only honor an explicit `--color=always` flag — eza, GNU ls,
 * ripgrep — are unreachable from the environment; forcing those is the user
 * shell's job, not ours.
 */
const COLOR_ENV: Readonly<Record<string, string>> = {
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
	CLICOLOR: "1",
	CLICOLOR_FORCE: "1",
	FORCE_COLOR: "3",
};

export interface NonInteractiveEnvOptions {
	/** Emit color instead of forcing `TERM=dumb` / `NO_COLOR=1`. */
	color?: boolean;
}

function colorEnabledBase(): Record<string, string> {
	const env: Record<string, string> = { ...NON_INTERACTIVE_ENV, ...COLOR_ENV };
	// Must be ABSENT, not empty: the Rust ecosystem checks
	// `env::var_os("NO_COLOR").is_some()`, so `NO_COLOR=""` still reads as
	// "colors disabled" for eza/delta/ripgrep.
	delete env.NO_COLOR;
	return env;
}

const WINDOWS_UTF8_ENV_DEFAULT_GROUPS: ReadonlyArray<ReadonlyArray<readonly [key: string, value: string]>> = [
	[
		["PYTHONIOENCODING", "utf-8"],
		["PYTHONUTF8", "1"],
	],
	[
		["LANG", "C.UTF-8"],
		["LC_ALL", "C.UTF-8"],
	],
];

function hasEnvValue(
	env: Record<string, string | undefined> | undefined,
	key: string,
	platform: NodeJS.Platform,
): boolean {
	if (!env) return false;
	if (platform !== "win32") return env[key] !== undefined;

	for (const [existingKey, value] of Object.entries(env)) {
		if (value !== undefined && existingKey.toLowerCase() === key.toLowerCase()) {
			return true;
		}
	}
	return false;
}

function hasLocaleEnvValue(env: Record<string, string | undefined> | undefined, platform: NodeJS.Platform): boolean {
	if (!env) return false;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
		if (normalizedKey === "LANG" || normalizedKey.startsWith("LC_")) return true;
	}
	return false;
}

function hasEnvGroupValue(
	env: Record<string, string | undefined> | undefined,
	group: ReadonlyArray<readonly [key: string, value: string]>,
	platform: NodeJS.Platform,
): boolean {
	if (group.some(([key]) => key === "LC_ALL") && hasLocaleEnvValue(env, platform)) return true;
	for (const [key] of group) {
		if (hasEnvValue(env, key, platform)) return true;
	}
	return false;
}

/** Copy of the base env with `CI` removed, for the `PI_BASH_NO_CI` opt-out. */
function withoutCI(env: Readonly<Record<string, string>>): Record<string, string> {
	const { CI: _ci, ...rest } = env;
	return rest;
}

/** Builds the per-command environment for non-interactive child processes. */
export function buildNonInteractiveEnv(
	overrides?: Record<string, string>,
	baseEnv: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
	options?: NonInteractiveEnvOptions,
): Record<string, string> {
	// `PI_BASH_NO_CI` (and its legacy alias) opts out of the automatic `CI=true`
	// injection. Mirrors the session-env gate in `procmgr.ts` so the opt-out
	// reaches the per-command env, which otherwise overrides the session value.
	const colorBase = options?.color === true ? colorEnabledBase() : NON_INTERACTIVE_ENV;
	const base = baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(colorBase) : colorBase;
	if (platform !== "win32") {
		return overrides ? { ...base, ...overrides } : base;
	}

	const env: Record<string, string> = { ...base };
	for (const group of WINDOWS_UTF8_ENV_DEFAULT_GROUPS) {
		if (hasEnvGroupValue(baseEnv, group, platform) || hasEnvGroupValue(overrides, group, platform)) {
			continue;
		}
		for (const [key, value] of group) {
			env[key] = value;
		}
	}
	return overrides ? { ...env, ...overrides } : env;
}
