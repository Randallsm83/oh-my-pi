import { describe, expect, test } from "bun:test";
import { Terminal } from "../src/vterm";

function write(terminal: Terminal, data: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write(data, resolve);
	return promise;
}

describe("vterm bracketed paste mode", () => {
	// Consumers decide whether to wrap pastes in ESC[200~ … ESC[201~ from this flag:
	// a program that never asked for it (a password prompt) must get the bare text.
	test("tracks DECSET/DECRST 2004 and clears it on a full reset", async () => {
		const terminal = new Terminal({ cols: 10, rows: 3 });
		expect(terminal.modes.bracketedPasteMode).toBe(false);

		await write(terminal, "\x1b[?2004h");
		expect(terminal.modes.bracketedPasteMode).toBe(true);

		await write(terminal, "\x1b[?2004l");
		expect(terminal.modes.bracketedPasteMode).toBe(false);

		await write(terminal, "\x1b[?2004h\x1bc");
		expect(terminal.modes.bracketedPasteMode).toBe(false);
	});
});
