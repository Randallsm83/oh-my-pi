/**
 * Bounded-exhaustive check of secret redaction (`packages/coding-agent/src/secrets`).
 *
 * Runs inside a snapshot directory prepared by `verify.ts`: `./secrets/*.ts` are copies of the real
 * modules. For each scenario it builds every sequence of up to `--depth` tokens, joins the tokens
 * into one text, sends it through a real `SecretObfuscator`, and checks the properties below.
 * Sequences are tried shortest first, so a reported counterexample is a shortest one.
 *
 * Credential-shaped test values are assembled from pieces at run time: a literal one in this file
 * would itself be redacted whenever an agent reads the file through omp.
 *
 * Options: `--depth N` (default 4), `--known FILE` (known-failures.jsonl), `--result FILE` (JSON
 * summary), `--write-known FILE` (rewrite the known-failure list from this run),
 * `--replay "SCENARIO SESSION TOKEN..."` (print every step of one case).
 */
import { type SecretEntry, SecretObfuscator } from "./secrets/obfuscator";
import { CREDENTIAL_PATTERNS } from "./secrets/patterns";
import { MIN_OBFUSCATE_SECRET_LEN, PLACEHOLDER_RE } from "./secrets/placeholder";
import { compileSecretRegex } from "./secrets/regex";

const PROPERTIES = ["NoCrash", "NoLeak", "LongestWins", "PatternsHide", "Restore", "FixedPoint"] as const;
type Property = (typeof PROPERTIES)[number];
type Session = "cold" | "warm";

/** Fixed so placeholders, and therefore counterexamples, are the same on every run. */
const PLACEHOLDER_KEY = "formal-verify-fixed-placeholder-key-0000001";

interface Scenario {
	name: string;
	about: string;
	entries: SecretEntry[];
	/** Configured plain secrets; none may be readable in what the provider sees. */
	plain: Record<string, string>;
	/** Raw texts whose redacted form from an earlier call is itself a token (`was:NAME`). */
	history: Record<string, string>;
	/** Every token, given the redacted form of each `history` text. */
	tokens(was: Record<string, string>): Record<string, string>;
	/** True when every entry is obfuscate-mode, so the redaction must be reversible. */
	reversible: boolean;
}

// Mirrors `builtinCredentialSecretEntries()` in secrets/index.ts.
const BUILTIN_ENTRIES: SecretEntry[] = CREDENTIAL_PATTERNS.map(pattern => ({
	type: "regex",
	content: pattern.source,
	flags: pattern.flags,
	mode: "obfuscate",
	friendlyName: pattern.name,
	literalPrefixes: pattern.literalPrefixes,
}));

const DASHES = "-".repeat(5);
const PEM_BEGIN = `${DASHES}BEGIN PRIVATE KEY${DASHES}`;
const PEM_END = `${DASHES}END PRIVATE KEY${DASHES}`;
const P_GH = `${"gh"}${"p_"}${"Ab3x".repeat(9)}`;
const P_PW = "hunter2-Passw0rd";
const P_OV = "Passw0rd-xyz987";
const P_HEAD = "hunter2-";
const T_GL = `${"gl"}${"pat-"}${"q7Zk".repeat(5)}`;
const T_AWS = `${"AK"}${"IA"}${"Q7ZK".repeat(4)}`;
const R_KEY = "s3cr3t/Key+1=";
const R_TOK = "tok.custom.9";

/** Mirrors `collectEnvSecrets()` in secrets/index.ts: env values become plain obfuscate-mode entries. */
function envEntry(content: string): SecretEntry {
	return { type: "plain", content, mode: "obfuscate" };
}

const SCENARIOS: Scenario[] = [
	{
		name: "env+builtin",
		about: "default session: secret-shaped environment values plus the built-in credential patterns",
		entries: [envEntry(P_GH), envEntry(P_PW), envEntry(P_OV), envEntry(P_HEAD), ...BUILTIN_ENTRIES],
		plain: { P_GH, P_PW, P_OV, P_HEAD },
		history: { P_GH, P_PW, T_GL },
		tokens: was => ({
			P_GH,
			P_PW,
			P_HEAD,
			T_GL,
			T_AWS,
			Passw0rd: "Passw0rd",
			"-xyz987": "-xyz987",
			"glpat-": `${"gl"}${"pat-"}`,
			Ab9: "Ab9",
			SPACE: " ",
			BEARER: "Bearer ",
			PEM_BEGIN,
			PEM_END,
			DOLLARS: "$$",
			FORGED: "$$ABCD1234$$",
			"was:P_GH": was.P_GH,
			"was:P_PW": was.P_PW,
			"was:T_GL": was.T_GL,
			// A placeholder under a friendly name the current config no longer uses still restores.
			"renamed:P_PW": `$$RENAMED_${was.P_PW.slice(2)}`,
		}),
		reversible: true,
	},
	{
		name: "secrets.yml",
		about: "user file with replace-mode literals, a labelled password, and custom patterns",
		entries: [
			{ type: "plain", content: R_KEY, mode: "replace" },
			{ type: "plain", content: R_TOK, mode: "replace", replacement: "[REDACTED]" },
			{ type: "plain", content: P_PW, mode: "obfuscate", friendlyName: "DbPassword" },
			{ type: "regex", content: "api_key=[A-Za-z0-9]{6,}", mode: "replace" },
			{ type: "regex", content: "tok_[a-z0-9]{8,}", mode: "obfuscate", friendlyName: "ServiceToken" },
			...BUILTIN_ENTRIES,
		],
		plain: { R_KEY, R_TOK, P_PW },
		history: { R_KEY, P_PW, API: "api_key=abc123XYZ", TOK: "tok_a1b2c3d4" },
		tokens: was => ({
			R_KEY,
			R_TOK,
			P_PW,
			"api_key=": "api_key=",
			abc123XYZ: "abc123XYZ",
			tok_: "tok_",
			a1b2c3d4: "a1b2c3d4",
			x: "x",
			SPACE: " ",
			DOLLARS: "$$",
			FORGED: "$$ABCD1234$$",
			REDACTED_MARK: "[REDACTED]",
			"was:R_KEY": was.R_KEY,
			"was:P_PW": was.P_PW,
			"was:API": was.API,
			"was:TOK": was.TOK,
		}),
		reversible: false,
	},
];

/** One failing case that the current code is known to have; a line of known-failures.jsonl. */
interface KnownCase {
	finding: string;
	scenario: string;
	property: Property;
	session: Session;
	tokens: string[];
}

interface FailingCase {
	property: Property;
	session: Session;
	tokens: string[];
	detail: string;
	input: string;
	output: string;
}

interface Prepared {
	scenario: Scenario;
	names: string[];
	texts: string[];
	warmText: string;
	patterns: Array<{ label: string; regex: RegExp; minLength: number }>;
	plain: Array<[name: string, value: string]>;
	/** Values shown by name in reports, longest first. */
	named: Array<[value: string, name: string]>;
}

function prepare(scenario: Scenario): Prepared {
	const template = new SecretObfuscator(scenario.entries, PLACEHOLDER_KEY);
	const was: Record<string, string> = {};
	for (const [name, raw] of Object.entries(scenario.history)) was[name] = template.obfuscate(raw);
	const tokens = scenario.tokens(was);
	const patterns = scenario.entries
		// A custom replacement may match its own pattern by the user's choice, so those entries are left out.
		.filter(entry => entry.type === "regex" && entry.replacement === undefined)
		.map(entry => ({
			label: entry.friendlyName ?? entry.content,
			regex: compileSecretRegex(entry.content, entry.flags),
			// Obfuscate-mode matches under the minimum length are left alone by design.
			minLength: (entry.mode ?? "obfuscate") === "obfuscate" ? MIN_OBFUSCATE_SECRET_LEN : 1,
		}));
	const named: Array<[string, string]> = [
		...Object.entries(scenario.plain).map(([name, value]): [string, string] => [value, name]),
		[T_GL, "T_GL"],
		[T_AWS, "T_AWS"],
		[PEM_BEGIN, "PEM_BEGIN"],
		[PEM_END, "PEM_END"],
	];
	named.sort((a, b) => b[0].length - a[0].length);
	return {
		scenario,
		names: Object.keys(tokens),
		texts: Object.values(tokens),
		warmText: [...Object.values(scenario.history), ...Object.values(scenario.plain), T_GL, T_AWS].join("\n"),
		patterns,
		plain: Object.entries(scenario.plain),
		named,
	};
}

const PLACEHOLDER_SCAN = new RegExp(PLACEHOLDER_RE.source, "g");

/**
 * A text split into readable stretches and live placeholders (`secret` set), the way the
 * obfuscator's own scans read it: when a placeholder-shaped text is not live, look again from its
 * closing `$$`, which may open a real placeholder (`resumePlaceholderScanAfterRejectedCandidate`).
 * `deobfuscate()` does not look again; that difference is finding F1.
 */
function segments(obfuscator: SecretObfuscator, text: string): Array<{ text: string; secret?: string }> {
	const parts: Array<{ text: string; secret?: string }> = [];
	let cursor = 0;
	PLACEHOLDER_SCAN.lastIndex = 0;
	for (let match = PLACEHOLDER_SCAN.exec(text); match !== null; match = PLACEHOLDER_SCAN.exec(text)) {
		const secret = obfuscator.deobfuscate(match[0]);
		if (secret === match[0]) {
			PLACEHOLDER_SCAN.lastIndex = match.index + match[0].length - 2;
			continue;
		}
		parts.push({ text: text.slice(cursor, match.index) }, { text: match[0], secret });
		cursor = match.index + match[0].length;
	}
	parts.push({ text: text.slice(cursor) });
	return parts;
}

/** The text with every live placeholder restored: what the obfuscator's pattern scan runs on. */
function scanView(obfuscator: SecretObfuscator, text: string): string {
	return segments(obfuscator, text)
		.map(part => part.secret ?? part.text)
		.join("");
}

/** Readable text for a report: secrets and PEM armor by name, `$$` as `§§`. */
function readable(prepared: Prepared, text: string): string {
	let shown = text;
	for (const [value, name] of prepared.named) shown = shown.split(value).join(`‹${name}›`);
	return shown.replaceAll("$$", "§§");
}

/**
 * A text for a report. `‹P_PW›` is that secret, readable. `‹hidden:P_PW›` is a placeholder this
 * session restores to it, and `‹hidden:T_GL as CREDENTIAL›` one that carries a friendly label.
 * Nothing printed is credential-shaped, so omp does not redact the report on its way to the reader.
 */
function display(prepared: Prepared, obfuscator: SecretObfuscator, text: string): string {
	return JSON.stringify(
		segments(obfuscator, text)
			.map(part => {
				if (part.secret === undefined) return readable(prepared, part.text);
				const secret = readable(prepared, part.secret).replace(/^‹([^‹›]*)›$/, "$1");
				const label = /^\$\$([A-Z0-9]+)_/.exec(part.text)?.[1];
				return label === undefined ? `‹hidden:${secret}›` : `‹hidden:${secret} as ${label}›`;
			})
			.join(""),
	);
}

function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);
	return found;
}

interface Aligned {
	/** The text with every live placeholder restored. */
	plain: string;
	/** Per character of `plain`: true when the provider sees a placeholder instead of it. */
	hidden: boolean[];
}

/** Which characters of the restored text a placeholder hides; undefined when `deobfuscate()` disagrees (F1). */
function align(obfuscator: SecretObfuscator, text: string): Aligned | undefined {
	const parts = segments(obfuscator, text);
	const plain = parts.map(part => part.secret ?? part.text).join("");
	if (plain !== obfuscator.deobfuscate(text)) return undefined;
	const hidden = parts.flatMap(part =>
		new Array<boolean>((part.secret ?? part.text).length).fill(part.secret !== undefined),
	);
	return { plain, hidden };
}

/**
 * LongestWins: a configured secret that sits raw in the input, with no equally long or longer
 * configured secret overlapping it, must be hidden completely, not in part.
 */
function longestWins(prepared: Prepared, before: Aligned, after: Aligned): string | undefined {
	const spans = prepared.plain.flatMap(([name, value]) =>
		occurrences(after.plain, value).map(start => ({ name, start, end: start + value.length })),
	);
	for (const span of spans) {
		if (before.hidden.slice(span.start, span.end).includes(true)) continue;
		const outranked = spans.some(
			other =>
				other !== span &&
				other.start < span.end &&
				span.start < other.end &&
				other.end - other.start >= span.end - span.start,
		);
		if (outranked) continue;
		const readableCount = after.hidden.slice(span.start, span.end).filter(isHidden => !isHidden).length;
		if (readableCount > 0) {
			return `${readableCount} of ${span.end - span.start} characters of ${span.name} stay readable`;
		}
	}
	return undefined;
}

/**
 * PatternsHide: a text that a pattern matches in the input must not be readable in the output at
 * that place. Counted, because the same text may also sit where the pattern does not match (glued
 * to a letter, say), and there the code leaves it alone by design.
 */
function patternsHide(prepared: Prepared, inputView: string, output: string): string | undefined {
	for (const { label, regex, minLength } of prepared.patterns) {
		const matched = new Map<string, number>();
		regex.lastIndex = 0;
		for (let match = regex.exec(inputView); match !== null; match = regex.exec(inputView)) {
			if (match[0].length === 0) regex.lastIndex++;
			else if (match[0].length >= minLength) matched.set(match[0], (matched.get(match[0]) ?? 0) + 1);
		}
		for (const [value, count] of matched) {
			if (occurrences(output, value).length > occurrences(inputView, value).length - count) {
				return `pattern ${label} matches ${JSON.stringify(readable(prepared, value))} in the input, and the provider can still read it`;
			}
		}
	}
	return undefined;
}

function containsRun(tokens: string[], run: string[]): boolean {
	for (let start = 0; start + run.length <= tokens.length; start++) {
		if (run.every((token, offset) => tokens[start + offset] === token)) return true;
	}
	return false;
}

interface Group {
	count: number;
	shortest: FailingCase;
}

/** What one scenario's run found. Only groups and minimal cases are kept, never every failing case. */
interface Tally {
	cases: number;
	/** Failures no known case explains, by property. */
	fresh: Map<Property, Group>;
	/** Failures longer than the known list covers, of a property that has known cases; not compared. */
	uncompared: Map<Property, Group>;
	/** Failures a known case explains, by property, then finding. */
	known: Map<Property, Map<string, Group>>;
	/** Failing cases that contain no shorter failing case of the same property and session. */
	minimal: FailingCase[];
	/** Known cases that failed exactly as listed. */
	reproduced: Set<KnownCase>;
}

/** known-failures.jsonl: the depth it was recorded at, then one known failing case per line. */
interface KnownList {
	recordedDepth: number;
	cases: KnownCase[];
}

function emptyTally(): Tally {
	return { cases: 0, fresh: new Map(), uncompared: new Map(), known: new Map(), minimal: [], reproduced: new Set() };
}

function checkCase(prepared: Prepared, known: KnownList, picks: number[], session: Session, tally: Tally): void {
	const { scenario } = prepared;
	const input = picks.map(pick => prepared.texts[pick]).join("");
	const tokens = picks.map(pick => prepared.names[pick]);
	const failed = new Set<Property>();
	const obfuscator = new SecretObfuscator(scenario.entries, PLACEHOLDER_KEY);
	let output = "";
	const fail = (property: Property, detail: string): void => {
		if (failed.has(property)) return;
		failed.add(property);
		const failure: FailingCase = {
			property,
			session,
			tokens,
			detail,
			input: display(prepared, obfuscator, input),
			output: display(prepared, obfuscator, output),
		};
		const explains = (other: { property: Property; session: Session; tokens: string[] }): boolean =>
			other.property === property && other.session === session && containsRun(tokens, other.tokens);
		if (!tally.minimal.some(explains)) tally.minimal.push(failure);
		const listed = known.cases.filter(entry => entry.scenario === scenario.name && entry.property === property);
		const cause = listed.find(explains);
		if (cause === undefined) {
			const bucket = listed.length > 0 && tokens.length > known.recordedDepth ? tally.uncompared : tally.fresh;
			const group = bucket.get(property);
			if (group === undefined) bucket.set(property, { count: 1, shortest: failure });
			else group.count++;
			return;
		}
		if (cause.tokens.length === tokens.length) tally.reproduced.add(cause);
		const findings = tally.known.get(property) ?? new Map<string, Group>();
		tally.known.set(property, findings);
		const group = findings.get(cause.finding);
		if (group === undefined) findings.set(cause.finding, { count: 1, shortest: failure });
		else group.count++;
	};
	tally.cases++;
	try {
		if (session === "warm") obfuscator.obfuscate(prepared.warmText);
		output = obfuscator.obfuscate(input);

		const second = obfuscator.obfuscate(output);
		if (second !== output) fail("FixedPoint", `a second pass changes it to ${display(prepared, obfuscator, second)}`);

		const inputView = scanView(obfuscator, input);
		const restoredInput = obfuscator.deobfuscate(input);
		// The SDK redacts outbound text twice, so what the provider sees is also checked after the second pass.
		for (const seen of second === output ? [output] : [output, second]) {
			const pass = seen === output ? "" : " after the second pass";
			for (const [name, value] of prepared.plain) {
				if (seen.includes(value)) fail("NoLeak", `configured secret ${name} is readable in what the provider sees${pass}`);
			}
			const unhidden = patternsHide(prepared, inputView, seen);
			if (unhidden !== undefined) fail("PatternsHide", `${unhidden}${pass}`);

			if (!scenario.reversible) continue;
			const restored = obfuscator.deobfuscate(seen);
			if (restored !== restoredInput) {
				fail(
					"Restore",
					`it restores to ${display(prepared, obfuscator, restored)}${pass}, the input restores to ${display(prepared, obfuscator, restoredInput)}`,
				);
				continue;
			}
			const before = align(obfuscator, input);
			const after = align(obfuscator, seen);
			if (before === undefined || after === undefined) continue;
			const partial = longestWins(prepared, before, after);
			if (partial !== undefined) fail("LongestWins", `${partial}${pass}`);
		}
	} catch (error) {
		fail("NoCrash", `threw ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Check every token sequence of a scenario, shortest first, in both sessions. */
function runScenario(prepared: Prepared, known: KnownList, depth: number): Tally {
	const tally = emptyTally();
	const width = prepared.texts.length;
	for (let length = 0; length <= depth; length++) {
		const picks = new Array<number>(length).fill(0);
		for (;;) {
			checkCase(prepared, known, picks, "cold", tally);
			checkCase(prepared, known, picks, "warm", tally);
			let position = length - 1;
			while (position >= 0 && picks[position] === width - 1) picks[position--] = 0;
			if (position < 0) break;
			picks[position]++;
		}
	}
	return tally;
}

function printCase(failure: FailingCase): void {
	console.log(`       tokens        : ${failure.tokens.map(token => `[${token}]`).join(" ") || "(empty text)"}`);
	console.log(`       session       : ${failure.session}`);
	console.log(`       input         : ${failure.input}`);
	console.log(`       provider sees : ${failure.output}`);
}

function option(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

/** Print every step of one case, named as `SCENARIO SESSION TOKEN...`, to study a counterexample. */
function replay(spec: string): void {
	const [scenarioName, session, ...tokens] = spec.split(/\s+/).filter(word => word.length > 0);
	const scenario = SCENARIOS.find(candidate => candidate.name === scenarioName);
	if (scenario === undefined) {
		throw new Error(`unknown scenario ${scenarioName}; have ${SCENARIOS.map(candidate => candidate.name).join(", ")}`);
	}
	if (session !== "cold" && session !== "warm") throw new Error("session is cold or warm");
	const prepared = prepare(scenario);
	const picks = tokens.map(token => {
		const pick = prepared.names.indexOf(token);
		if (pick === -1) throw new Error(`unknown token ${token}; have ${prepared.names.join(" ")}`);
		return pick;
	});
	const input = picks.map(pick => prepared.texts[pick]).join("");
	const obfuscator = new SecretObfuscator(scenario.entries, PLACEHOLDER_KEY);
	if (session === "warm") obfuscator.obfuscate(prepared.warmText);
	const first = obfuscator.obfuscate(input);
	const second = obfuscator.obfuscate(first);
	console.log(`input               : ${display(prepared, obfuscator, input)}`);
	console.log(`provider sees       : ${display(prepared, obfuscator, first)}`);
	console.log(`after a second pass : ${display(prepared, obfuscator, second)}`);
	console.log(`input restores to   : ${display(prepared, obfuscator, obfuscator.deobfuscate(input))}`);
	console.log(`output restores to  : ${display(prepared, obfuscator, obfuscator.deobfuscate(first))}`);
	console.log(`scan view of input  : ${display(prepared, obfuscator, scanView(obfuscator, input))}`);
	console.log(`scan view of output : ${display(prepared, obfuscator, scanView(obfuscator, first))}`);
	const tally = emptyTally();
	checkCase(prepared, { recordedDepth: Number.POSITIVE_INFINITY, cases: [] }, picks, session, tally);
	for (const failure of tally.minimal) console.log(`FAIL ${failure.property}: ${failure.detail}`);
	if (tally.minimal.length === 0) console.log("every property holds on this case");
}

async function main(): Promise<void> {
	const replaySpec = option("--replay");
	if (replaySpec !== undefined) {
		replay(replaySpec);
		return;
	}
	const depth = Number(option("--depth") ?? 4);
	if (!Number.isInteger(depth) || depth < 0) throw new Error("--depth takes a non-negative integer");
	const knownFile = option("--known");
	const known: KnownList = { recordedDepth: depth, cases: [] };
	if (knownFile !== undefined) {
		for (const line of (await Bun.file(knownFile).text()).split("\n")) {
			if (line.trim().length === 0) continue;
			const entry = JSON.parse(line) as KnownCase | { recordedDepth: number };
			if ("recordedDepth" in entry) known.recordedDepth = entry.recordedDepth;
			else known.cases.push(entry);
		}
	}

	const results: Record<string, Record<string, string>> = {};
	const minimal: KnownCase[] = [];
	const reproduced = new Set<KnownCase>();
	let newFailures = 0;
	for (const scenario of SCENARIOS) {
		console.log(`\nscenario ${scenario.name}: ${scenario.about}`);
		const started = performance.now();
		let prepared: Prepared;
		try {
			prepared = prepare(scenario);
		} catch (error) {
			newFailures++;
			results[scenario.name] = { NoCrash: "fail" };
			console.log(
				`  FAIL NoCrash: redacting the scenario's history texts threw ${error instanceof Error ? error.message : String(error)}`,
			);
			console.log("       the other properties were not checked for this scenario");
			continue;
		}
		const tally = runScenario(prepared, known, depth);
		const seconds = ((performance.now() - started) / 1000).toFixed(1);
		console.log(
			`  ${tally.cases} cases: every sequence of 0..${depth} of ${prepared.names.length} tokens, in a cold and a warm session (${seconds}s)`,
		);
		for (const entry of tally.reproduced) reproduced.add(entry);
		for (const failure of tally.minimal) {
			const listed = known.cases.find(
				entry =>
					entry.scenario === scenario.name &&
					entry.property === failure.property &&
					entry.session === failure.session &&
					entry.tokens.join("\n") === failure.tokens.join("\n"),
			);
			minimal.push({
				finding: listed?.finding ?? "UNTRIAGED",
				scenario: scenario.name,
				property: failure.property,
				session: failure.session,
				tokens: failure.tokens,
			});
		}
		results[scenario.name] = {};
		for (const property of PROPERTIES) {
			if (!scenario.reversible && (property === "Restore" || property === "LongestWins")) continue;
			const findings = tally.known.get(property) ?? new Map<string, Group>();
			for (const [finding, group] of findings) {
				console.log(`  KNOWN ${property}, finding ${finding}, ${group.count} cases; shortest: ${group.shortest.detail}`);
				printCase(group.shortest);
			}
			const uncompared = tally.uncompared.get(property);
			if (uncompared !== undefined) {
				console.log(
					`  UNCOMPARED ${property}, ${uncompared.count} cases longer than the known list covers (${known.recordedDepth} tokens); shortest: ${uncompared.shortest.detail}`,
				);
				printCase(uncompared.shortest);
			}
			const fresh = tally.fresh.get(property);
			if (fresh !== undefined) {
				newFailures += fresh.count;
				results[scenario.name][property] = "fail";
				console.log(`  FAIL ${property}, ${fresh.count} cases; shortest: ${fresh.shortest.detail}`);
				printCase(fresh.shortest);
			} else if (findings.size > 0) {
				results[scenario.name][property] = `known:${[...findings.keys()].sort().join(",")}`;
				console.log(`  PASS ${property} on every other case`);
			} else {
				results[scenario.name][property] = "pass";
				console.log(`  PASS ${property}`);
			}
		}
	}

	const gone = known.cases.filter(entry => entry.tokens.length <= depth && !reproduced.has(entry));
	if (gone.length > 0) console.log("");
	for (const entry of gone.slice(0, 5)) {
		console.log(
			`NOTE: known ${entry.property} case ${entry.tokens.map(token => `[${token}]`).join(" ")} (${entry.session}, finding ${entry.finding}) no longer fails.`,
		);
	}
	if (gone.length > 5) console.log(`NOTE: ${gone.length - 5} more known cases no longer fail.`);
	if (gone.length > 0) {
		console.log("If the code fixed a finding, rewrite the known list and the findings in SKILL.md.");
	}

	const writeKnown = option("--write-known");
	if (writeKnown !== undefined) {
		const lines = [{ recordedDepth: depth }, ...minimal].map(entry => `${JSON.stringify(entry)}\n`);
		await Bun.write(writeKnown, lines.join(""));
		console.log(`\nwrote ${minimal.length} minimal failing cases to ${writeKnown}`);
	}
	const resultFile = option("--result");
	if (resultFile !== undefined) {
		await Bun.write(
			resultFile,
			`${JSON.stringify({ depth, results, newFailures, knownGone: gone.length }, null, "\t")}\n`,
		);
	}
	const findings = [...new Set([...reproduced].map(entry => entry.finding))].sort();
	if (newFailures > 0) console.log(`\nRESULT: ${newFailures} failing case(s) that are not known findings`);
	else if (findings.length > 0) console.log(`\nRESULT: no new failure; known finding(s) ${findings.join(", ")} still present`);
	else console.log("\nRESULT: all properties hold within the bound");
	process.exitCode = newFailures === 0 ? 0 : 1;
}

await main();
