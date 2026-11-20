import { beforeAll, describe, expect, it } from "bun:test";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, type TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import type { ShellTrace, ShellVizPresentation } from "@oh-my-pi/pi-wire";

// Output a `bash.color` run stores: a red word, a mid-line reset, then a row
// carrying a cursor-control escape the transcript must never replay.
const OUTPUT = "\x1b[31mred\x1b[0mtail\na\x1b[2Kb";
const RED = "\x1b[31mred";

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
let dark: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	expect(loaded).toBeDefined();
	dark = loaded!;
	setThemeInstance(dark);
});

function renderToolCard(toolName: string, tool?: unknown, output: string = OUTPUT): string {
	const card = new ToolExecutionComponent(
		toolName,
		{ command: "ls --color" },
		{ useBuiltInRenderer: true },
		tool as never,
		ui,
	);
	card.updateResult({ content: [{ type: "text", text: output }] });
	return card.render(100).join("\n");
}

function renderUserCommandBlock(output: string = OUTPUT): string {
	const block = new BashExecutionComponent("ls --color", ui, false);
	block.appendOutput(output);
	block.setComplete(0, false);
	return block.render(100).join("\n");
}

describe("transcript styling", () => {
	it("keeps a bash command's colors on its tool card, returning to the theme color after a reset", () => {
		const rendered = renderToolCard("bash");

		expect(rendered).toContain(RED);
		expect(rendered).toContain(`${dark.getFgAnsi("toolOutput")}tail`);
	});

	it("keeps traced bash output colors and resets without replaying cursor controls", () => {
		const trace: ShellTrace = { v: 1, seq: 1, status: 0, t_ns: 1, script: "ls --color", units: [] };
		const presentation: ShellVizPresentation = {
			preferences: {
				view: "pseudo",
				layers: { color: true, inline: true, idioms: true, effects: true, unwrap: false },
				split: false,
				playing: false,
				speed: 1,
				expandedNodes: [],
			},
			rows: [{ id: "r0", depth: 0, segments: [{ text: "ls --color" }], effects: [] }],
			original: [],
			output: OUTPUT,
			executing: false,
			watches: [],
			timeline: { length: 1, cursor: 1, elapsedNs: 1, durationNs: 1 },
		};
		const rendered = bashToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "unselected output" }], details: { trace } },
				{ expanded: false, isPartial: false, shell: true, shellTrace: trace, shellPresentation: presentation },
				dark,
				{ command: "ls --color" },
			)
			.render(100)
			.join("\n");

		expect(rendered).toContain(RED);
		expect(rendered).toContain(`${dark.getFgAnsi("toolOutput")}tail`);
		expect(rendered).toContain("ab");
		expect(rendered).not.toContain("\x1b[2K");
		expect(rendered).not.toContain("unselected output");
	});

	it("keeps a user command's colors, returning to the muted color after a reset", () => {
		const rendered = renderUserCommandBlock();

		expect(rendered).toContain(RED);
		expect(rendered).toContain(`${dark.getFgAnsi("muted")}tail`);
	});

	it("never replays cursor-control escapes from command output", () => {
		for (const rendered of [renderToolCard("bash"), renderUserCommandBlock()]) {
			expect(rendered).toContain("ab");
			expect(rendered).not.toContain("\x1b[2K");
		}
	});

	it("shows other tools' output as plain text", () => {
		const rendered = renderToolCard("custom", { label: "custom" });

		expect(rendered).toContain("redtail");
		expect(rendered).not.toContain(RED);
		expect(rendered).toContain("ab");
		expect(rendered).not.toContain("\x1b[2K");
	});
});

describe("transcript styling of SIXEL output", () => {
	it.each(["user command block", "custom-tool raw fallback"] as const)(
		"renders SIXEL rows on the %s unstyled",
		surface => {
			const SIXEL = "\x1bPqabc\x1b\\";
			const originalProtocol = TERMINAL.imageProtocol;
			const originalForce = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
			const originalAllow = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
			Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
			Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
			setTerminalImageProtocol(ImageProtocol.Sixel);
			try {
				const output = `before\n${SIXEL}\nafter`;
				const rendered =
					surface === "user command block"
						? renderUserCommandBlock(output)
						: renderToolCard("custom", { label: "custom", renderCall: () => undefined }, output);
				const color = surface === "user command block" ? "muted" : "toolOutput";

				// Styling the row would drop the payload or paint a theme color in front of it.
				expect(rendered).toContain(SIXEL);
				expect(rendered).not.toContain(`${dark.getFgAnsi(color)}${SIXEL}`);
			} finally {
				setTerminalImageProtocol(originalProtocol);
				if (originalForce === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
				else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForce;
				if (originalAllow === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
				else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllow;
			}
		},
	);
});
