import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type Component, setKittyProtocolActive, TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { PtyKeyboard, type PtyInputModes, userCommandOwnsKeyboard } from "@oh-my-pi/pi-tui/chat/pty-keyboard";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

/** A focusable stand-in that records the keys it receives (the prompt box, or a dialog). */
function keySink(): Component & { keys: string[] } {
	const keys: string[] = [];
	return { keys, handleInput: data => keys.push(data), render: () => [], invalidate() {} };
}

const LEGACY_MODES: PtyInputModes = { applicationCursorKeysMode: false, bracketedPasteMode: false };

const releases: Array<() => void> = [];
afterEach(() => {
	// The running command is process-global state; never let one leak into the next test.
	for (const release of releases.splice(0)) release();
});

/** A running user command on a real TUI: the prompt box holds focus until the run takes it. */
function runningCommand(modes: PtyInputModes = LEGACY_MODES) {
	const tui = new TUI(new VirtualTerminal(80, 24));
	const prompt = keySink();
	tui.addChild(prompt);
	tui.setFocus(prompt);
	const writes: string[] = [];
	const cancels: string[] = [];
	const owner: Component & { keyboard?: PtyKeyboard } = {
		handleInput: data => owner.keyboard?.handleInput(data),
		render: () => [],
		invalidate() {},
	};
	tui.addChild(owner);
	const keyboard = new PtyKeyboard({
		ui: tui,
		owner,
		releaseTo: prompt,
		write: data => writes.push(data),
		cancel: () => cancels.push("cancel"),
		modes: () => modes,
	});
	owner.keyboard = keyboard;
	releases.push(() => keyboard.release());
	return { tui, prompt, owner, keyboard, writes, cancels };
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

describe("user command keyboard ownership", () => {
	it("takes the keyboard when the run starts, so typed keys, Enter and arrows reach the command", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const prompt = keySink();
		tui.addChild(prompt);
		tui.setFocus(prompt);
		const block = new BashExecutionComponent("picker", tui, false);
		tui.addChild(block);
		const writes: string[] = [];
		block.setPtyInput(
			data => writes.push(data),
			() => {},
			prompt,
		);
		releases.push(() => block.setComplete(0, false));

		for (const key of ["y", "\r", "\u001b[B", "\u001b[A"]) tui.injectDebugInput(key);

		expect(writes).toEqual(["y", "\r", "\u001b[B", "\u001b[A"]);
		expect(prompt.keys).toEqual([]);
	});

	it("forwards Esc to the command and cancels only on Ctrl+]", () => {
		const { tui, writes, cancels } = runningCommand();

		tui.injectDebugInput("\u001b");
		expect(writes).toEqual(["\u001b"]);
		expect(cancels).toEqual([]);

		tui.injectDebugInput("\u001d");
		expect(cancels).toEqual(["cancel"]);
		expect(writes).toEqual(["\u001b"]);
	});

	it("translates kitty-encoded keys to legacy bytes and drops key releases", () => {
		setKittyProtocolActive(true);
		try {
			const { tui, writes, cancels } = runningCommand();
			tui.injectDebugInput("\u001b[1;1:1B");
			tui.injectDebugInput("\u001b[1;1:3B");
			tui.injectDebugInput("\u001b[13;1:1u");
			tui.injectDebugInput("\u001b[93;5u");

			expect(writes).toEqual(["\u001b[B", "\r"]);
			expect(cancels).toEqual(["cancel"]);
		} finally {
			setKittyProtocolActive(false);
		}
	});

	it("takes the keyboard back from the prompt box after a dialog returned focus there", () => {
		const { tui, prompt, owner, writes } = runningCommand();
		tui.setFocus(prompt);

		tui.injectDebugInput("x");

		expect(writes).toEqual(["x"]);
		expect(prompt.keys).toEqual([]);
		expect(tui.getFocused()).toBe(owner);
	});

	it("leaves keys to an open dialog", () => {
		const { tui, writes } = runningCommand();
		const dialog = keySink();
		tui.showOverlay(dialog);

		tui.injectDebugInput("x");

		expect(dialog.keys).toEqual(["x"]);
		expect(writes).toEqual([]);
	});

	it("returns the keyboard to the prompt box when the run ends and drops later keys", () => {
		const { tui, prompt, keyboard, writes } = runningCommand();

		keyboard.release();
		tui.injectDebugInput("x");

		expect(tui.getFocused()).toBe(prompt);
		expect(prompt.keys).toEqual(["x"]);
		expect(writes).toEqual([]);
	});

	it("does not take focus away from a dialog when the run ends", () => {
		const { tui, keyboard } = runningCommand();
		const dialog = keySink();
		tui.showOverlay(dialog);

		keyboard.release();

		expect(tui.getFocused()).toBe(dialog);
	});

	it("claims the keyboard for app shortcuts only while it runs and no dialog is open", () => {
		const { tui, prompt, keyboard } = runningCommand();
		expect(userCommandOwnsKeyboard(tui)).toBe(true);

		tui.setFocus(prompt);
		expect(userCommandOwnsKeyboard(tui)).toBe(true);

		const handle = tui.showOverlay(keySink());
		expect(userCommandOwnsKeyboard(tui)).toBe(false);
		handle.hide();

		keyboard.release();
		expect(userCommandOwnsKeyboard(tui)).toBe(false);
	});
});

describe("user command pastes", () => {
	const PASTE = "\u001b[200~pa$$word\u001b[201~";

	it("unwraps a pasted chunk for a program that did not ask for bracketed pastes, keeping the Enter", () => {
		const { tui, writes } = runningCommand(LEGACY_MODES);

		tui.injectDebugInput(`${PASTE}\r`);

		expect(writes).toEqual(["pa$$word", "\r"]);
	});

	it("keeps the paste markers for a program that asked for them", () => {
		const { tui, writes } = runningCommand({ applicationCursorKeysMode: false, bracketedPasteMode: true });

		tui.injectDebugInput(PASTE);

		expect(writes).toEqual([PASTE]);
	});

	it("wraps a clipboard paste delivered as text only when the program asked for markers", () => {
		const plain = runningCommand(LEGACY_MODES);
		plain.keyboard.pasteText("abc");
		plain.keyboard.release();
		const bracketed = runningCommand({ applicationCursorKeysMode: false, bracketedPasteMode: true });
		bracketed.keyboard.pasteText("abc");

		expect(plain.writes).toEqual(["abc"]);
		expect(bracketed.writes).toEqual(["\u001b[200~abc\u001b[201~"]);
	});
});
