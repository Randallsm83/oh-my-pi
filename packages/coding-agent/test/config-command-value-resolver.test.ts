import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfigValue as resolveSync } from "@oh-my-pi/pi-coding-agent/config/model-config-values";
import { resolveConfigValue as resolveAsync } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A `!command` that appends one tick to `counterFile` per execution, then prints `token`. */
function countedTokenValue(counterFile: string, token: string): string {
	if (process.platform !== "win32") {
		return `!printf 1 >> ${shellQuote(counterFile)}; printf %s ${shellQuote(token)}`;
	}
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");process.stdout.write(${JSON.stringify(token)});`;
	return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** A `!command` that appends one tick to `counterFile` per execution, then exits non-zero. */
function countedFailingValue(counterFile: string): string {
	if (process.platform !== "win32") return `!printf 1 >> ${shellQuote(counterFile)}; exit 1`;
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");process.exit(1);`;
	return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

// Every test builds its command from a fresh temp path, so each one is a distinct
// cache key in the process-wide store and cannot be answered by a sibling test.
describe("!command config values are resolved once per process", () => {
	let tempDir = "";
	let counterFile = "";

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-test-command-value-resolver-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
	});

	afterEach(() => {
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	// Regression: separate caches per resolver meant a single `!op read` apiKey
	// spawned one `op` process at startup and another on the first request, so
	// Windows charged the user two Windows Hello prompts per launch.
	test("the async resolver reuses a value the sync resolver already resolved", async () => {
		const valueConfig = countedTokenValue(counterFile, "sync-first-token");

		expect(resolveSync(valueConfig)).toBe("sync-first-token");
		expect(await resolveAsync(valueConfig)).toBe("sync-first-token");

		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("the sync resolver reuses a value the async resolver already resolved", async () => {
		const valueConfig = countedTokenValue(counterFile, "async-first-token");

		expect(await resolveAsync(valueConfig)).toBe("async-first-token");
		expect(resolveSync(valueConfig)).toBe("async-first-token");

		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	// The async resolver never negative-cached, so a broken `!op read` re-ran on
	// every resolution and prompted every time instead of once per retry window.
	test("a failed command is not retried by the other resolver inside the retry window", async () => {
		const valueConfig = countedFailingValue(counterFile);

		expect(resolveSync(valueConfig)).toBeUndefined();
		expect(await resolveAsync(valueConfig)).toBeUndefined();

		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("forceCommandRefresh re-runs the command and republishes to the async resolver", async () => {
		const valueConfig = countedTokenValue(counterFile, "refreshed-token");

		expect(resolveSync(valueConfig)).toBe("refreshed-token");
		expect(resolveSync(valueConfig, { forceCommandRefresh: true })).toBe("refreshed-token");
		expect(await resolveAsync(valueConfig)).toBe("refreshed-token");

		expect(fs.readFileSync(counterFile, "utf8")).toBe("11");
	});

	test("concurrent async resolutions share a single execution", async () => {
		const valueConfig = countedTokenValue(counterFile, "shared-token");

		const results = await Promise.all([
			resolveAsync(valueConfig),
			resolveAsync(valueConfig),
			resolveAsync(valueConfig),
		]);

		expect(results).toEqual(["shared-token", "shared-token", "shared-token"]);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});
});
