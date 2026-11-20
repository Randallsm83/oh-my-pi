import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	Container,
	Text,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolActivityContainer } from "@oh-my-pi/pi-tui/chrome/tool-activity";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Regression coverage for a resize on Warp under Windows ConPTY leaving the
// screen unrecoverable (scrolled-up duplicate transcript, apparently dead
// input).
//
// The in-place resize path is default-on for Warp: it never borrows the alt
// buffer, skips the ResizeScrollbackMode replay, and instead anchors one settled
// repaint on a DSR (CSI 6n) round trip against a parked cursor. Both halves of
// that contract are false under ConPTY, measured on conhost with omp 18.1.15
// (`PtySession` at 80x24, cursor parked at row 5 column 20):
//
//   - resizing the pseudoconsole makes conhost re-emit its own viewport from
//     `CSI H` with absolute addressing, with the application writing nothing;
//   - the DSR reply after that resize is `CSI 3;1R` (and `CSI 7;1R` after a
//     width shrink) — conhost re-homed the cursor, so the reply never carries
//     the probe's tag column and can never be attributed.
//
// So the probe always times out, the anchor is a guess against a grid conhost
// has already overwritten, and nothing rebuilds the display afterwards. On a
// ConPTY host the resize must therefore keep the alt-screen borrow, whose
// settled transaction ends in the destructive rebuild replay.

const ALT_ENTER = "\x1b[?1049h";
const ED3 = "\x1b[3J";
const DSR = "\x1b[6n";
const COMMITTED = ["committed-0", "committed-1", "committed-2"];

/**
 * Windows ConPTY host: answers DSR from its own re-homed cursor (column 1
 * always) and repaints its viewport into the stream on every resize.
 */
class ConPtyTerminal extends VirtualTerminal {
	readonly hostOwnsGridOnResize = true;
	hostRepaints = 0;
	cprReplies: string[] = [];

	override write(data: string): void {
		const probe = data.indexOf("\x1b[6n");
		if (probe === -1) {
			super.write(data);
			return;
		}
		super.write(data.slice(0, probe) + data.slice(probe + 4));
		const reply = `\x1b[${this.getCursor().row + 1};1R`;
		this.cprReplies.push(reply);
		queueMicrotask(() => this.sendInput(reply));
	}

	override resize(columns: number, rows: number): void {
		const stale = this.getViewport().map(row => row.trimEnd());
		super.resize(columns, rows);
		this.hostRepaints++;
		super.write(`\x1b[?25l\x1b[H${stale.map(row => `${row}\x1b[K`).join("\r\n")}\x1b[H\x1b[?25h`);
	}
}

class ReplayProvider implements TerminalFrameProvider {
	history: TerminalFramePlan["history"];
	liveRows = 6;
	#nextId = 1;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: Math.min(this.liveRows, viewport.rows) }, (_v, index) => `live-${index}`);
		return { history: this.history, viewport: rows };
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(this.liveRows, viewport.rows) }, (_v, index) => `resize-${index}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
	beginHistoryReplay(): void {
		this.history = { id: ++this.#nextId, rows: COMMITTED, kind: "replay" };
	}
}

class ResizeScheduler {
	#pending = new Set<() => void>();
	t = 0;
	now(): number {
		return this.t;
	}
	scheduleImmediate(callback: () => void): void {
		callback();
	}
	scheduleRender(callback: () => void, _delayMs?: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}
	settle(): void {
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}

function startRig() {
	const terminal = new ConPtyTerminal(40, 12);
	const provider = new ReplayProvider();
	provider.history = { id: 1, rows: COMMITTED };
	const renderScheduler = new ResizeScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler });
	const writes: string[] = [];
	const originalWrite = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		originalWrite(data);
	};
	tui.setFrameProvider(provider);
	// The coding agent's setting; `preserve` (the raw TUI default) has no replay.
	tui.setResizeScrollback("rebuild");
	tui.start();
	return { terminal, tui, provider, renderScheduler, writes };
}

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme();
});

describe("resize on Warp hosted by Windows ConPTY", () => {
	beforeEach(() => {
		Bun.env.TERM = "xterm-256color";
		Bun.env.TERM_PROGRAM = "WarpTerminal";
	});

	it("rebuilds the transcript instead of anchoring a repaint conhost already overwrote", async () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			renderScheduler.settle(); // leave the borrow, start the settled probe
			renderScheduler.settle(); // probe timeout (no attributable reply)
			renderScheduler.settle(); // settled repaint
			const emitted = writes.join("");

			// conhost repainted its stale viewport with absolute addressing, so the
			// settled resize must erase native history and re-stream the ledger.
			expect(terminal.hostRepaints).toBe(1);
			expect(emitted).toContain(ED3);
			expect(emitted).toContain(COMMITTED[0]);
			// The reply could only report column 1, so the probe is never sent: a
			// dead tag column is never reclaimed and the repaint would wait out the
			// full timeout for it.
			expect(emitted).not.toContain(DSR);
			expect(terminal.cprReplies).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("borrows the alt buffer exactly once, so the Warp toggle echo cannot loop", async () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			// Warp echoes a height-only ±1 resize on each alt-buffer toggle.
			terminal.resize(40, 19);
			renderScheduler.settle();
			renderScheduler.settle();
			renderScheduler.settle();

			const borrows = writes.join("").split(ALT_ENTER).length - 1;
			expect(borrows).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("keeps the DSR probe inside a multiplexer, which answers it from its own grid", async () => {
		// WSL-in-tmux is ConPTY-hosted, but tmux consumes the CSI 6n and replies
		// from the grid it owns, so the reply carries the tag column after all.
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const { terminal, tui, renderScheduler, writes } = startRig();
		// A rebuild settle repaints from row zero and needs no anchor; the probe
		// serves every settle that repaints over retained history.
		tui.setResizeScrollback("preserve");
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			renderScheduler.settle();
			renderScheduler.settle();

			expect(writes.join("")).toContain(DSR);
		} finally {
			tui.stop();
		}
	});

	it("keeps the DSR probe when PI_TUI_RESIZE_IN_PLACE=1 forces in-place repaint", async () => {
		// The escape hatch restores the whole pre-change path, anchor probe
		// included: an in-place repaint is only as good as its anchor.
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			renderScheduler.settle();
			renderScheduler.settle();

			const emitted = writes.join("");
			expect(emitted).toContain(DSR);
			expect(emitted).not.toContain(ALT_ENTER);
		} finally {
			tui.stop();
		}
	});

	it.each([false, true])(
		"keeps the completed table prefix in every ConPTY paint (completeScrollback=%s)",
		async completeScrollback => {
			Bun.env.TERM_PROGRAM = "WezTerm";
			const terminal = new ConPtyTerminal(100, 36);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true, completeScrollback, resizeScrollback: "rebuild" },
			});
			const transcript = new TranscriptContainer();
			for (const tool of ["TOOL_ONE", "TOOL_TWO", "TOOL_THREE"]) {
				transcript.addChild(new ToolActivityContainer(new Text(tool, 0, 0)));
			}
			transcript.addChild(new Text("TIMESTAMP 17:19", 0, 0));
			const answer = new AssistantMessageComponent(undefined, true);
			const ongoing = new AssistantMessageComponent(undefined, true);
			ongoing.setMidStreamPublication(false);
			answer.setMidStreamPublication(false);
			transcript.addChild(answer);
			const editor = new Text("EDITOR", 0, 0);
			const hud = new Container();
			composer.setRuntimeChildren([transcript, hud, editor], {
				transientChrome: [editor],
				selfClearingChrome: [hud],
			});
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-6.1-sol",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1,
			};
			const head = [
				"INTRO_SENTINEL Complete evidence follows.",
				"",
				"## TITLE_SENTINEL",
				"",
				"| HEADER_SENTINEL | Evidence |",
				"|---|---|",
				"| ROW01_SENTINEL | first result |",
			].join("\n");
			const text = [
				head,
				...Array.from({ length: 5 }, (_, index) => `| ROW0${index + 2}_SENTINEL | result ${index + 2} |`),
				"",
				...Array.from(
					{ length: 10 },
					(_, index) => `Paragraph ${index}: complete evidence remains available in transcript history.\n`,
				),
			].join("\n");
			composer.start({ playWelcomeIntro: false });
			try {
				for (const value of [head, text]) {
					answer.updateContent({ ...message, content: [{ type: "text", text: value }] }, { transient: true });
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					expect(answer.isTranscriptBlockFinalized()).toBe(false);
				}
				answer.updateContent({ ...message, content: [{ type: "text", text }] });
				answer.markTranscriptBlockFinalized();
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const markers = [
					"TOOL_ONE",
					"TOOL_TWO",
					"TOOL_THREE",
					"TIMESTAMP",
					"INTRO_SENTINEL",
					"TITLE_SENTINEL",
					"HEADER_SENTINEL",
					"ROW01_SENTINEL",
				];
				for (const marker of markers) expect(terminal.getScrollBuffer().join("\n")).toContain(marker);

				ongoing.updateContent(
					{ ...message, content: [{ type: "text", text: "ACTIVE_SENTINEL first update" }] },
					{ transient: true },
				);
				transcript.addChild(ongoing);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const missingByPaint: string[][] = [];
				let replayPaints = 0;
				const stopObserving = composer.ui.addPaintListener(paint => {
					if (paint.alt) return;
					if (paint.reset) replayPaints++;
					const buffer = terminal.getScrollBuffer().join("\n");
					const missing = markers.filter(marker => buffer.split(marker).length !== 2);
					if (missing.length > 0) missingByPaint.push(missing);
				});
				try {
					terminal.resize(72, 36);
					await scheduler.advance(terminal, 160);
					expect(missingByPaint).toEqual([]);
					expect(replayPaints).toBeGreaterThan(0);
					expect(ongoing.isTranscriptBlockFinalized()).toBe(false);

					terminal.resize(100, 36);
					await scheduler.advance(terminal, 160);
					expect(missingByPaint).toEqual([]);
					composer.ui.resetDisplay();
					await scheduler.settle(terminal);
					expect(missingByPaint).toEqual([]);
					expect(ongoing.isTranscriptBlockFinalized()).toBe(false);
					ongoing.updateContent(
						{ ...message, content: [{ type: "text", text: "ACTIVE_SENTINEL second update" }] },
						{ transient: true },
					);
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					expect(terminal.getViewport().join("\n")).toContain("second update");
					for (const marker of markers) expect(terminal.getScrollBuffer().join("\n")).toContain(marker);
				} finally {
					stopObserving();
				}
			} finally {
				answer.dispose();
				ongoing.dispose();
				await composer.stop();
			}
		},
	);

	it.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	])(
		"includes a wholly live answer's prefix after a discarded header replay",
		async (completeScrollback, initialPressure) => {
			Bun.env.TERM_PROGRAM = "WezTerm";
			const terminal = new ConPtyTerminal(100, 60);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true, completeScrollback, resizeScrollback: "rebuild" },
			});
			const transcript = new TranscriptContainer();
			const warmup = new Text(Array.from({ length: 60 }, () => "EDITOR WARMUP").join("\n"), 0, 0);
			composer.setHeaderExtras([new Text("RETIRED_BOOT_SENTINEL", 0, 0)], []);
			composer.setRuntimeChildren([transcript, warmup]);
			const answer = new AssistantMessageComponent(undefined, true);
			answer.setMidStreamPublication(false);
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: [
							"INTRO_SENTINEL Complete evidence follows.",
							"",
							"## TITLE_SENTINEL",
							"",
							"| HEADER_SENTINEL | Evidence |",
							"|---|---|",
							"| ROW01_SENTINEL | first result |",
							"",
							...Array.from(
								{ length: 16 },
								(_, index) =>
									`Paragraph ${index}: complete evidence remains available in transcript history.\n`,
							),
						].join("\n"),
					},
				],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-6.1-sol",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1,
			};
			composer.start({ playWelcomeIntro: false });
			try {
				await scheduler.settle(terminal);
				expect(terminal.getScrollBuffer().join("\n")).toContain("RETIRED_BOOT_SENTINEL");
				answer.updateContent(message);
				answer.markTranscriptBlockFinalized();
				transcript.addChild(answer);
				composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				expect(transcript.canRemoveBlock(answer)).toBe(true);
				const initialRows = initialPressure ? trimBlankEdges(answer.render(100)).length : 60;
				const renderFrame = composer.renderFrame.bind(composer);
				let discardFirstFrame = true;
				composer.renderFrame = viewport => {
					if (discardFirstFrame) {
						discardFirstFrame = false;
						const discarded = renderFrame({ columns: 100, rows: initialRows });
						expect(discarded.history?.kind).toBe("replay");
						expect(transcript.canRemoveBlock(answer)).toBe(!initialPressure);
						expect(transcript.blockStates()).toEqual(["settled"]);
					}
					return renderFrame(viewport);
				};

				const markers = [
					"RETIRED_BOOT_SENTINEL",
					"INTRO_SENTINEL",
					"TITLE_SENTINEL",
					"HEADER_SENTINEL",
					"ROW01_SENTINEL",
				];
				const missingByPaint: string[][] = [];
				let replayPaints = 0;
				const stopObserving = composer.ui.addPaintListener(paint => {
					if (paint.alt) return;
					if (paint.reset) replayPaints++;
					const buffer = terminal.getScrollBuffer().join("\n");
					const missing = markers.filter(marker => buffer.split(marker).length !== 2);
					if (missing.length > 0) missingByPaint.push(missing);
				});
				try {
					terminal.resize(40, 24);
					await scheduler.advance(terminal, 160);
					expect(missingByPaint).toEqual([]);
					expect(replayPaints).toBeGreaterThan(0);
					expect(transcript.canRemoveBlock(answer)).toBe(false);
				} finally {
					stopObserving();
					composer.renderFrame = renderFrame;
				}
			} finally {
				answer.dispose();
				await composer.stop();
			}
		},
	);

	it("includes all newly displaced rows in the first header replay despite the normal retirement budget", async () => {
		Bun.env.TERM_PROGRAM = "WezTerm";
		const terminal = new ConPtyTerminal(80, 60);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, completeScrollback: true, resizeScrollback: "rebuild" },
		});
		const transcript = new TranscriptContainer();
		composer.setHeaderExtras([new Text("BUDGET_BOOT_SENTINEL", 0, 0)], []);
		composer.setRuntimeChildren([
			transcript,
			new Text(Array.from({ length: 60 }, () => "EDITOR WARMUP").join("\n"), 0, 0),
		]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const markers = ["BUDGET_BOOT_SENTINEL"];
			for (let index = 0; index < 6; index++) {
				const marker = `BUDGET_ROW_${index}`;
				markers.push(marker);
				transcript.addChild({
					render: () => {
						const until = performance.now() + 4;
						while (performance.now() < until) {}
						return [marker];
					},
				});
			}
			composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(transcript.children.every(block => transcript.canRemoveBlock(block))).toBe(true);
			const missingByPaint: string[][] = [];
			let replayPaints = 0;
			const stopObserving = composer.ui.addPaintListener(paint => {
				if (paint.alt) return;
				if (paint.reset) replayPaints++;
				const buffer = terminal.getScrollBuffer().join("\n");
				const missing = markers.filter(marker => buffer.split(marker).length !== 2);
				if (missing.length > 0) missingByPaint.push(missing);
			});
			try {
				terminal.resize(80, 1);
				await scheduler.advance(terminal, 160);
				expect(replayPaints).toBeGreaterThan(0);
				expect(missingByPaint).toEqual([]);
			} finally {
				stopObserving();
			}
		} finally {
			await composer.stop();
		}
	});
});
