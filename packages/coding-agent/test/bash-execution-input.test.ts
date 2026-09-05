import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI as TUIType } from "@oh-my-pi/pi-tui";
import { setKittyProtocolActive, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUIType;

/** A component wired to a live PTY, with the bytes and cancels it produced. */
function wired(command = "picker"): {
	component: BashExecutionComponent;
	writes: string[];
	cancels: string[];
} {
	const component = new BashExecutionComponent(command, ui, false);
	const writes: string[] = [];
	const cancels: string[] = [];
	component.setPtyInput(
		data => writes.push(data),
		() => cancels.push("cancel"),
	);
	return { component, writes, cancels };
}

describe("BashExecutionComponent PTY input", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("forwards typed characters and Enter to the running command", () => {
		const { component, writes } = wired();
		component.handleInput("y");
		component.handleInput("\r");

		// Without forwarding, a command that prompts renders its question and
		// then blocks until its deadline because nothing can answer it.
		expect(writes).toEqual(["y", "\r"]);
	});

	it("forwards arrow keys so a selection list can be navigated", () => {
		const { component, writes } = wired();
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[A");

		// The reported failure was exactly this: a wizard's ↑↓ picker could be
		// seen but never driven. Cursor sequences must pass through intact
		// rather than being swallowed as an unrecognized key.
		expect(writes).toEqual(["\u001b[B", "\u001b[A"]);
	});

	it("cancels the run on Esc instead of writing an escape byte", () => {
		const { component, writes, cancels } = wired();
		component.handleInput("\u001b");

		// While this component holds focus the input controller's own Esc
		// handler is unreachable, so forwarding Esc to the PTY would leave a
		// command that ignores it with no way out short of killing the session.
		expect(cancels).toEqual(["cancel"]);
		expect(writes).toEqual([]);
	});

	it("drops keys once the command has completed", () => {
		const { component, writes } = wired();
		component.setComplete(0, false, { output: "" });
		component.handleInput("x");

		// A keystroke racing the command's exit must not be written to a PTY
		// that has already gone away.
		expect(writes).toEqual([]);
	});

	it("stays inert when no PTY was wired", () => {
		// Negative control: the non-PTY fallback (bash snapshot path, or
		// PI_NO_PTY=1) never calls setPtyInput, so the component is
		// display-only and a keystroke must be a no-op rather than a crash.
		const component = new BashExecutionComponent("ls", ui, false);
		expect(() => component.handleInput("x")).not.toThrow();
	});

	it("receives stdin through the real TUI pipeline when focused", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const component = new BashExecutionComponent("picker", tui, false);
		const writes: string[] = [];
		tui.addChild(component);
		component.setPtyInput(
			data => writes.push(data),
			() => {},
		);
		tui.setFocus(component);
		tui.injectDebugInput("\u001b[B");

		// Every assertion above calls handleInput directly, so all of them pass
		// on a build where the run is wired but never focused - which is exactly
		// how this shipped broken: keys kept going to the composer. Only driving
		// the real stdin pipeline can tell the two apart.
		expect(writes).toEqual(["\u001b[B"]);
	});

	it("routes Enter through the real TUI pipeline instead of the composer's submit", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const component = new BashExecutionComponent("picker", tui, false);
		const writes: string[] = [];
		tui.addChild(component);
		component.setPtyInput(
			data => writes.push(data),
			() => {},
		);
		tui.setFocus(component);
		tui.injectDebugInput("\r");

		// Enter is the composer's own submit key, so of every keystroke it is
		// the one most likely to be eaten before it reaches a focused run. The
		// arrow test above cannot catch that: a wizard that takes arrows but
		// never Enter still looks interactive while being unanswerable.
		expect(writes).toEqual(["\r"]);
	});

	it("receives nothing while another component holds focus", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const component = new BashExecutionComponent("picker", tui, false);
		const other = new BashExecutionComponent("other", tui, false);
		const writes: string[] = [];
		tui.addChild(component);
		tui.addChild(other);
		component.setPtyInput(
			data => writes.push(data),
			() => {},
		);
		tui.setFocus(other);
		tui.injectDebugInput("\u001b[B");

		// Negative control for the test above: proves it passes because focus
		// routes the key, not because injectDebugInput broadcasts to every
		// component that happens to be wired.
		expect(writes).toEqual([]);
	});
	it("translates kitty-encoded keys into the legacy bytes the command expects", () => {
		// WezTerm negotiates the kitty keyboard protocol, so a real session never
		// delivers "\u001b[B" or "\r" — it delivers CSI-u form carrying an event
		// type. The PTY child speaks legacy encodings, so these must be
		// translated, not passed through. The PTY repro used to verify the
		// repaint fix never negotiated kitty, so it could not have caught this.
		setKittyProtocolActive(true);
		try {
			const { component, writes } = wired();
			component.handleInput("\u001b[1;1:1B");
			component.handleInput("\u001b[13;1:1u");
			expect(writes).toEqual(["\u001b[B", "\r"]);
		} finally {
			setKittyProtocolActive(false);
		}
	});

	it("drops kitty key-release events so one keypress is not delivered twice", () => {
		setKittyProtocolActive(true);
		try {
			const { component, writes } = wired();
			component.handleInput("\u001b[1;1:1B");
			component.handleInput("\u001b[1;1:3B");
			// A release forwarded as a second Down would move a picker two rows
			// for every single keypress.
			expect(writes).toEqual(["\u001b[B"]);
		} finally {
			setKittyProtocolActive(false);
		}
	});
});
