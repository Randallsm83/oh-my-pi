/**
 * Keyboard ownership for a running interactive user command (`!` on a PTY).
 *
 * While the command runs it owns the keyboard: every key, paste, and Esc goes
 * to the program, app-wide shortcuts stand down ({@link userCommandOwnsKeyboard}),
 * and only Ctrl+] cancels the run. If a dialog takes focus meanwhile, the next
 * key after it closes hands the keyboard back to the command. When the run
 * ends, the keyboard returns to the prompt box.
 */
import { matchesKey } from "../keys";
import { normalizeInputForPty } from "../tools/bash-interactive";
import type { Component, TUI } from "../tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Input modes the running program has switched on, as tracked by its terminal emulator. */
export interface PtyInputModes {
	readonly applicationCursorKeysMode: boolean;
	readonly bracketedPasteMode: boolean;
}

export interface PtyKeyboardOptions {
	ui: TUI;
	/** Component that shows the run; it holds focus while the command owns the keyboard. */
	owner: Component;
	/** Where the keyboard returns when the run ends: the prompt box. */
	releaseTo: Component;
	/** Write bytes to the program; may throw once it has exited. */
	write(data: string): void;
	cancel(): void;
	modes(): PtyInputModes;
}

type FocusView = Pick<TUI, "getFocused" | "hasOverlay">;

// Only one user command runs at a time: a second `!` is refused while one is running.
let active: PtyKeyboard | undefined;

/**
 * Whether a running user command owns the keyboard, so app-wide shortcuts must
 * not act on the key. Also true while the prompt box holds focus with no dialog
 * open: that key is about to be handed back to the command.
 */
export function userCommandOwnsKeyboard(ui: FocusView): boolean {
	return active?.claims(ui) ?? false;
}

export class PtyKeyboard {
	readonly #opts: PtyKeyboardOptions;
	readonly #stopReclaiming: () => void;
	#released = false;

	constructor(opts: PtyKeyboardOptions) {
		this.#opts = opts;
		active = this;
		// Runs after the app's listeners (which stand down via userCommandOwnsKeyboard)
		// and before focus dispatch, so the key itself reaches the command.
		this.#stopReclaiming = opts.ui.addInputListener(() => {
			if (this.claims(opts.ui)) opts.ui.setFocus(opts.owner);
			return undefined;
		});
		opts.ui.setFocus(opts.owner);
	}

	claims(ui: FocusView): boolean {
		if (this.#released) return false;
		const focused = ui.getFocused();
		return focused === this.#opts.owner || (focused === this.#opts.releaseTo && !ui.hasOverlay());
	}

	handleInput(data: string): void {
		if (this.#released) return;
		if (matchesKey(data, "ctrl+]")) {
			this.#opts.cancel();
			return;
		}
		// The host terminal delivers a paste as one wrapped chunk, possibly followed by Enter.
		if (data.startsWith(PASTE_START)) {
			const end = data.indexOf(PASTE_END);
			if (end !== -1) {
				this.pasteText(data.slice(PASTE_START.length, end));
				const rest = data.slice(end + PASTE_END.length);
				if (rest) this.handleInput(rest);
				return;
			}
		}
		const normalized = normalizeInputForPty(data, this.#opts.modes().applicationCursorKeysMode);
		if (normalized) this.#write(normalized);
	}

	/** Paste into the program, wrapped only when it asked for bracketed pastes. */
	pasteText(text: string): void {
		if (this.#released) return;
		this.#write(this.#opts.modes().bracketedPasteMode ? `${PASTE_START}${text}${PASTE_END}` : text);
	}

	/** The run ended: stop reclaiming and give the keyboard back if the command still holds it. */
	release(): void {
		if (this.#released) return;
		this.#released = true;
		this.#stopReclaiming();
		if (active === this) active = undefined;
		if (this.#opts.ui.getFocused() === this.#opts.owner) this.#opts.ui.setFocus(this.#opts.releaseTo);
	}

	#write(data: string): void {
		try {
			this.#opts.write(data);
		} catch {
			// The command exited between the keypress and the write.
		}
	}
}
