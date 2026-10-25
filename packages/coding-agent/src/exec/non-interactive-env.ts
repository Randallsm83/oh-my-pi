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
	// A config-file `sequence.editor` outranks GIT_EDITOR and would block `git rebase -i`.
	GIT_SEQUENCE_EDITOR: "true",
	// Git Credential Manager GUI/browser auth dialogs ignore GIT_TERMINAL_PROMPT.
	GCM_INTERACTIVE: "never",
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
 * Locale pinned for agent commands: byte-order collation, `C` numbers, dates,
 * and English messages like `C`, but UTF-8 text, which `C` would split into bytes.
 */
const AGENT_LOCALE_ENV: Readonly<Record<string, string>> = {
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
};

/**
 * {@link AGENT_LOCALE_ENV} for macOS, which ships no `C.UTF-8` (`initdb` and
 * `perl` reject it): every category is `C` but `LC_CTYPE`, whose `en_US.UTF-8`
 * is macOS's plain `UTF-8` character table. `LC_ALL` is empty, which POSIX
 * reads as unset, so an inherited `LC_ALL` cannot mask the categories, and each
 * category is named so an inherited `LC_*` cannot leak through.
 */
const DARWIN_AGENT_LOCALE_ENV: Readonly<Record<string, string>> = {
	LANG: "C",
	LC_ALL: "",
	LC_COLLATE: "C",
	LC_CTYPE: "en_US.UTF-8",
	LC_MESSAGES: "C",
	LC_MONETARY: "C",
	LC_NUMERIC: "C",
	LC_TIME: "C",
};

/** Python stdio defaults for Windows, where the console code page is not UTF-8. */
const WINDOWS_PYTHON_UTF8_ENV: Readonly<Record<string, string>> = {
	PYTHONIOENCODING: "utf-8",
	PYTHONUTF8: "1",
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

function colorEnabledBase(): Record<string, string> {
	const env: Record<string, string> = { ...NON_INTERACTIVE_ENV, ...COLOR_ENV };
	// Must be ABSENT, not empty: the Rust ecosystem checks
	// `env::var_os("NO_COLOR").is_some()`, so `NO_COLOR=""` still reads as
	// "colors disabled" for eza/delta/ripgrep.
	delete env.NO_COLOR;
	return env;
}

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

function hasEnvGroupValue(
	env: Record<string, string | undefined> | undefined,
	group: Readonly<Record<string, string>>,
	platform: NodeJS.Platform,
): boolean {
	for (const key in group) {
		if (hasEnvValue(env, key, platform)) return true;
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

/** Copy of the base env with `CI` removed, for the `PI_BASH_NO_CI` opt-out. */
function withoutCI(env: Readonly<Record<string, string>>): Record<string, string> {
	const { CI: _ci, ...rest } = env;
	return rest;
}

/** Options for {@link buildNonInteractiveEnv}. */
export interface NonInteractiveEnvOptions {
	/** Env the child inherits from the launcher. */
	baseEnv?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	/** Keep the inherited locale instead of pinning {@link AGENT_LOCALE_ENV}: user-typed `!` commands. */
	inheritLocale?: boolean;
	/** Emit color instead of forcing `TERM=dumb` / `NO_COLOR=1`. */
	color?: boolean;
}

/** Builds the per-command environment for non-interactive child processes. */
export function buildNonInteractiveEnv(
	overrides?: Record<string, string>,
	{
		baseEnv = Bun.env,
		platform = process.platform,
		inheritLocale = false,
		color = false,
	}: NonInteractiveEnvOptions = {},
): Record<string, string> {
	// `PI_BASH_NO_CI` (and its legacy alias) opts out of the automatic `CI=true`
	// injection. Mirrors the session-env gate in `procmgr.ts` so the opt-out
	// reaches the per-command env, which otherwise overrides the session value.
	const colorBase = color ? colorEnabledBase() : { ...NON_INTERACTIVE_ENV };
	const env = baseEnv.PI_BASH_NO_CI || baseEnv.CLAUDE_BASH_NO_CI ? withoutCI(colorBase) : colorBase;

	// Agent commands pin the locale whatever the launcher inherited, so sort
	// order, number formats, and messages do not vary by machine; a locale in
	// the command's own env opts out. Inherited-locale commands still get UTF-8
	// on Windows when nothing names a locale.
	const pinLocale = !inheritLocale || (platform === "win32" && !hasLocaleEnvValue(baseEnv, platform));
	if (pinLocale && !hasLocaleEnvValue(overrides, platform)) {
		Object.assign(env, platform === "darwin" ? DARWIN_AGENT_LOCALE_ENV : AGENT_LOCALE_ENV);
	}

	if (
		platform === "win32" &&
		!hasEnvGroupValue(baseEnv, WINDOWS_PYTHON_UTF8_ENV, platform) &&
		!hasEnvGroupValue(overrides, WINDOWS_PYTHON_UTF8_ENV, platform)
	) {
		Object.assign(env, WINDOWS_PYTHON_UTF8_ENV);
	}
	return overrides ? { ...env, ...overrides } : env;
}
