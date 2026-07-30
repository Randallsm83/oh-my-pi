import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { styleOutputBlock, styleOutputLine } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

const RESET = "\x1b[0m";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

describe("styleOutputLine", () => {
	it("renders escape-free output exactly as a flat theme color", async () => {
		const t = await theme();

		expect(styleOutputLine("plain text", t)).toBe(t.fg("toolOutput", "plain text"));
		expect(styleOutputLine("plain text", t, "muted")).toBe(t.fg("muted", "plain text"));
	});

	it("keeps a command's own color over the theme base", async () => {
		const t = await theme();
		const base = t.getFgAnsi("toolOutput");

		expect(styleOutputLine(`\x1b[32mok\x1b[0m`, t)).toBe(`${base}\x1b[32mok${RESET}${base}${RESET}`);
	});

	it("re-applies the base color after a reset so the rest of the line stays styled", async () => {
		const t = await theme();
		const base = t.getFgAnsi("toolOutput");
		const styled = styleOutputLine(`\x1b[31mred\x1b[0mtail`, t);

		// Without the re-apply the trailing text would fall back to the
		// terminal's default foreground instead of the theme's.
		expect(styled).toBe(`${base}\x1b[31mred${RESET}${base}tail${RESET}`);
	});

	it("drops escapes the transcript may not replay", async () => {
		const t = await theme();
		const base = t.getFgAnsi("toolOutput");

		// Cursor movement must never reach the terminal from tool output.
		expect(styleOutputLine("a\x1b[2Kb", t)).toBe(`${base}ab${RESET}`);
	});
});

describe("styleOutputBlock", () => {
	it("styles each line of a colored block independently", async () => {
		const t = await theme();
		const base = t.getFgAnsi("toolOutput");

		expect(styleOutputBlock(`\x1b[34mdir\x1b[0m\nfile`, t)).toBe(
			`${base}\x1b[34mdir${RESET}${base}${RESET}\n${base}file${RESET}`,
		);
	});

	it("wraps an escape-free block once, unchanged from the previous renderer", async () => {
		const t = await theme();

		expect(styleOutputBlock("one\ntwo", t)).toBe(t.fg("toolOutput", "one\ntwo"));
	});
});
