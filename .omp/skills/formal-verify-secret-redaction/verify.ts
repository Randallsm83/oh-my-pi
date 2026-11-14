/**
 * Runner for the secret-redaction check. It never writes inside the repository: it copies the
 * covered files into a fresh run directory under the state directory and runs `harness.ts` there.
 *
 *   bun verify.ts                    check the checkout (depth 4)
 *   bun verify.ts --depth 5          deeper bound, minutes instead of seconds
 *   bun verify.ts --self-test        show that each property fails on a broken variant
 *   bun verify.ts --replay "SCENARIO SESSION TOKEN..."   print every step of one case
 *   bun verify.ts --root DIR         check a copy laid out like the repository
 *   bun verify.ts --write-known      rewrite known-failures.jsonl from this run
 *   bun verify.ts --record-sync      rewrite coverage.json for the current commit
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const SKILL_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SKILL_DIR, "../../..");
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "formal-omp-fork");
const SECRETS_DIR = "packages/coding-agent/src/secrets";
const TOKEN_RE_FILE = "packages/ai/src/providers/transform-messages.ts";
/** Files the harness loads. `index.ts` is covered too, but only mirrored by hand in harness.ts. */
const SNAPSHOT_FILES = [
	"obfuscator.ts",
	"patterns.ts",
	"placeholder-scan.ts",
	"placeholder.ts",
	"regex.ts",
	"registry-revision.ts",
	"replacement.ts",
];
const COVERED_FILES = [...SNAPSHOT_FILES, "index.ts"].map(file => `${SECRETS_DIR}/${file}`).concat(TOKEN_RE_FILE);

interface Mutant {
	id: string;
	/** What the broken variant does, in plain words. */
	breaks: string;
	file: string;
	find: string;
	replace: string;
	scenario: string;
	property: string;
}

/** One broken variant per property. `find` must occur exactly once in `file`. */
const MUTANTS: Mutant[] = [
	{
		id: "throw-on-default-replacement",
		breaks: "a replace-mode pattern match loses its generated replacement",
		file: "obfuscator.ts",
		find: "defaultReplacement = this.#generateRegexReplacement(scanMatchValue, regex, scanContext);",
		replace: "this.#generateRegexReplacement(scanMatchValue, regex, scanContext);",
		scenario: "secrets.yml",
		property: "NoCrash",
	},
	{
		id: "min-length-off-by-one",
		breaks: "a configured secret of exactly the minimum length is skipped",
		file: "obfuscator.ts",
		find: "if (entry.content.length < MIN_OBFUSCATE_SECRET_LEN) {",
		replace: "if (entry.content.length <= MIN_OBFUSCATE_SECRET_LEN) {",
		scenario: "env+builtin",
		property: "NoLeak",
	},
	{
		id: "shortest-secret-first",
		breaks: "configured secrets are replaced shortest first instead of longest first",
		file: "obfuscator.ts",
		find: "this.#sortedPlainEntries ??= [...this.#plainMappings].sort((a, b) => b[0].length - a[0].length);",
		replace: "this.#sortedPlainEntries ??= [...this.#plainMappings].sort((a, b) => a[0].length - b[0].length);",
		scenario: "env+builtin",
		property: "LongestWins",
	},
	{
		id: "missing-literal-prefix",
		breaks: "the built-in Credential pattern's literalPrefixes list forgets the GitLab prefix",
		file: "patterns.ts",
		find: '"github_pat_", "glpat-", "sk-"]',
		replace: '"github_pat_", "sk-"]',
		scenario: "env+builtin",
		property: "PatternsHide",
	},
	{
		id: "placeholder-maps-to-placeholder-text",
		breaks: "a pattern match that contains a placeholder is stored unrestored, so it restores to placeholder text",
		file: "obfuscator.ts",
		find: "canonicalValue = canonical.text;",
		replace: "canonicalValue = text.slice(start, end);",
		scenario: "env+builtin",
		property: "Restore",
	},
	{
		id: "always-strip-friendly-prefix",
		breaks: "a placeholder's friendly label is stripped whenever the text is read again",
		file: "obfuscator.ts",
		find: "const replacement = unprefixed !== undefined ? this.#placeholderForCurrentInput(placeholder) : placeholder;",
		replace: "const replacement = unprefixed ?? placeholder;",
		scenario: "env+builtin",
		property: "FixedPoint",
	},
];

function option(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

async function sha256(file: string): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex");
}

/** Copy the covered files from `root` into `directory`, with a stand-in for the one pi-ai import. */
async function snapshot(root: string, directory: string): Promise<void> {
	for (const file of SNAPSHOT_FILES) {
		await Bun.write(path.join(directory, "secrets", file), Bun.file(path.join(root, SECRETS_DIR, file)));
	}
	// patterns.ts imports one regex from pi-ai; the rest of that module is not needed.
	const source = await Bun.file(path.join(root, TOKEN_RE_FILE)).text();
	const literals = [...source.matchAll(/^export const SENSITIVE_TOKEN_RE =\s*(\/.+\/[a-z]*);$/gm)];
	if (literals.length !== 1) {
		throw new Error(`expected one SENSITIVE_TOKEN_RE regex literal in ${TOKEN_RE_FILE}; update snapshot() and the coverage record`);
	}
	await Bun.write(
		path.join(directory, "node_modules/@oh-my-pi/pi-ai/providers/transform-messages.ts"),
		`export const SENSITIVE_TOKEN_RE =\n\t${literals[0][1]};\n`,
	);
	await Bun.write(path.join(directory, "harness.ts"), Bun.file(path.join(SKILL_DIR, "harness.ts")));
}

async function runHarness(directory: string, args: string[]): Promise<{ exitCode: number; output: string }> {
	const run = await $`${process.execPath} harness.ts ${args}`.cwd(directory).nothrow().quiet();
	return { exitCode: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
}

interface Coverage {
	syncCommit: string;
	files: Record<string, string>;
}

/** Say which covered files differ from the ones the verification was last confirmed against. */
async function reportDrift(root: string): Promise<string[]> {
	const coverage = (await Bun.file(path.join(SKILL_DIR, "coverage.json")).json()) as Coverage;
	const changed: string[] = [];
	for (const [file, expected] of Object.entries(coverage.files)) {
		const actual = await sha256(path.join(root, file)).catch(() => "missing");
		if (actual !== expected) changed.push(actual === "missing" ? `${file} (missing)` : file);
	}
	const lines =
		changed.length === 0
			? [`covered files match sync commit ${coverage.syncCommit}`]
			: [
					`covered files changed since sync commit ${coverage.syncCommit}:`,
					...changed.map(file => `  ${file}`),
					"The check below runs on the changed code. Before trusting a pass, confirm the scenarios and",
					"properties still describe it (SKILL.md, 'When the covered code changed').",
				];
	return lines;
}

async function recordSync(): Promise<void> {
	const head = (await $`git -C ${REPO_ROOT} rev-parse HEAD`.text()).trim();
	const dirty = (await $`git -C ${REPO_ROOT} status --porcelain -- ${COVERED_FILES}`.text()).trim();
	if (dirty.length > 0) throw new Error(`covered files have uncommitted changes; commit first:\n${dirty}`);
	const files: Record<string, string> = {};
	for (const file of COVERED_FILES) files[file] = await sha256(path.join(REPO_ROOT, file));
	const coverage: Coverage = { syncCommit: head, files };
	await Bun.write(path.join(SKILL_DIR, "coverage.json"), `${JSON.stringify(coverage, null, "\t")}\n`);
	console.log(`coverage.json now records sync commit ${head}`);
}

/** Everything printed for a run, saved beside the snapshot as report.txt. */
const transcript: string[] = [];
function say(text: string): void {
	console.log(text);
	transcript.push(text);
}

async function selfTest(root: string, runDirectory: string): Promise<number> {
	const known = path.join(SKILL_DIR, "known-failures.jsonl");
	let survivors = 0;
	for (const mutant of MUTANTS) {
		const directory = path.join(runDirectory, "mutants", mutant.id);
		await snapshot(root, directory);
		const target = path.join(directory, "secrets", mutant.file);
		const source = await Bun.file(target).text();
		const occurrences = source.split(mutant.find).length - 1;
		if (occurrences !== 1) {
			survivors++;
			say(`ERROR ${mutant.id}: its anchor text occurs ${occurrences} times in ${mutant.file}, not once.`);
			say("      The code changed there; rewrite this entry of MUTANTS in verify.ts.");
			continue;
		}
		await Bun.write(target, source.replace(mutant.find, () => mutant.replace));
		const resultFile = path.join(directory, "result.json");
		const { output } = await runHarness(directory, ["--depth", "3", "--known", known, "--result", resultFile]);
		await Bun.write(path.join(directory, "report.txt"), output);
		const result = (await Bun.file(resultFile).json()) as { results: Record<string, Record<string, string>> };
		const caught = result.results[mutant.scenario]?.[mutant.property] === "fail";
		if (!caught) survivors++;
		say(`${caught ? "CAUGHT" : "MISSED"} ${mutant.property} when ${mutant.breaks}`);
		const lines = output.split("\n");
		const failLine = lines.findIndex(line => line.includes(`FAIL ${mutant.property}`));
		if (failLine !== -1) say(lines.slice(failLine, failLine + 5).join("\n"));
	}
	say(
		survivors === 0
			? `\nSELF-TEST: all ${MUTANTS.length} broken variants were caught`
			: `\nSELF-TEST: ${survivors} of ${MUTANTS.length} broken variants were not caught`,
	);
	return survivors === 0 ? 0 : 1;
}

async function check(root: string, runDirectory: string): Promise<number> {
	if (process.argv.includes("--self-test")) return selfTest(root, runDirectory);

	const directory = path.join(runDirectory, "snapshot");
	await snapshot(root, directory);
	const replay = option("--replay");
	if (replay !== undefined) {
		const { exitCode, output } = await runHarness(directory, ["--replay", replay]);
		say(output);
		return exitCode;
	}
	const depth = option("--depth") ?? "4";
	const args = ["--depth", depth, "--known", path.join(SKILL_DIR, "known-failures.jsonl")];
	args.push("--result", path.join(runDirectory, "result.json"));
	if (process.argv.includes("--write-known")) args.push("--write-known", path.join(SKILL_DIR, "known-failures.jsonl"));
	say(`running every case up to depth ${depth} (about half a minute at depth 4, six to nine minutes at depth 5)`);
	const { exitCode, output } = await runHarness(directory, args);
	say(output);
	return exitCode;
}

async function main(): Promise<number> {
	if (process.argv.includes("--record-sync")) {
		await recordSync();
		return 0;
	}
	// The repository's own engines floor; the covered code uses `RegExp.escape` and `Bun.CryptoHasher`.
	if (!Bun.semver.satisfies(Bun.version, ">=1.3.14")) {
		throw new Error(`bun ${Bun.version} is too old; the repository needs >=1.3.14`);
	}
	const root = path.resolve(option("--root") ?? REPO_ROOT);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
	const runDirectory = path.join(STATE_DIR, "runs", `${stamp}-${process.pid}`);
	await fs.mkdir(runDirectory, { recursive: true });
	say(`checking ${path.join(root, SECRETS_DIR)} with bun ${Bun.version}`);
	say(`evidence: ${runDirectory}`);
	for (const line of await reportDrift(root)) say(line);
	try {
		return await check(root, runDirectory);
	} finally {
		await Bun.write(path.join(runDirectory, "report.txt"), `${transcript.join("\n")}\n`);
	}
}

process.exitCode = await main();
