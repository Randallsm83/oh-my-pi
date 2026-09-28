import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-xdev-");

const USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Call {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

async function writeSession(calls: Call[]): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--xdev");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	const entry = JSON.stringify({
		type: "message",
		id: "a1",
		timestamp: "2026-09-20T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp: 1789000000000,
			content: calls.map(call => ({ type: "toolCall", ...call })),
		},
	});
	await Bun.write(file, `${entry}\n`);
	return file;
}

// MCP and other mounted tools are invoked as `write xd://<tool>`; persisting
// the carrier name buried every one of them under `write`, so per-tool usage
// read as zero no matter how often the server was called.
describe("xd:// device tool attribution", () => {
	it("attributes a device write to the mounted tool, not to write", async () => {
		const file = await writeSession([
			{ id: "c1", name: "write", arguments: { path: "xd://mcp__qdrant_find", content: '{"query":"x"}' } },
		]);

		const result = await parseSessionFile(file);

		expect(result.toolCalls.map(c => c.toolName)).toEqual(["mcp__qdrant_find"]);
	});

	it("keeps a docs read and an ordinary file write under their own names", async () => {
		const file = await writeSession([
			{ id: "c1", name: "read", arguments: { path: "xd://mcp__qdrant_find" } },
			{ id: "c2", name: "write", arguments: { path: "src/index.ts", content: "x" } },
		]);

		const result = await parseSessionFile(file);

		expect(result.toolCalls.map(c => c.toolName)).toEqual(["read", "write"]);
	});

	it("falls back to write when the device path is absent or unusable", async () => {
		const file = await writeSession([
			{ id: "c1", name: "write", arguments: { content: "x" } },
			{ id: "c2", name: "write", arguments: { path: "xd://", content: "x" } },
		]);

		const result = await parseSessionFile(file);

		expect(result.toolCalls.map(c => c.toolName)).toEqual(["write", "write"]);
	});
});
