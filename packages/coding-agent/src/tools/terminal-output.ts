import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";

const ESC = "\x1b";
const RESET = "\x1b[0m";
const SGR = /\x1b\[([0-9;]*)m/g;

interface TerminalCell {
	getChars(): string;
	getWidth(): number;
	getFgColor(): number;
	getBgColor(): number;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isInverse(): number;
	isStrikethrough(): number;
	isOverline(): number;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
}

function addColor(codes: number[], cell: TerminalCell, foreground: boolean): void {
	const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
	const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
	if (!rgb && !palette) return;

	const color = foreground ? cell.getFgColor() : cell.getBgColor();
	codes.push(foreground ? 38 : 48);
	if (rgb) {
		codes.push(2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
	} else {
		codes.push(5, color);
	}
}

function cellStyle(cell: TerminalCell): string {
	const codes: number[] = [];
	if (cell.isBold() !== 0) codes.push(1);
	if (cell.isDim() !== 0) codes.push(2);
	if (cell.isItalic() !== 0) codes.push(3);
	if (cell.isUnderline() !== 0) codes.push(4);
	if (cell.isInverse() !== 0) codes.push(7);
	if (cell.isStrikethrough() !== 0) codes.push(9);
	if (cell.isOverline() !== 0) codes.push(53);
	addColor(codes, cell, true);
	addColor(codes, cell, false);
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/**
 * Presentation-only SGR codes: the attributes, their off-counterparts, and the
 * basic / bright / default color slots. None can move the cursor, conceal text,
 * or blink, so all are safe to replay verbatim. Extended color (`38`/`48`) is
 * validated separately because it carries sub-arguments, and `0` is handled by
 * the callers so a reset can re-apply the base color.
 *
 * The virtual-terminal path only ever emits `38`/`48`, but real command output
 * mostly uses the basic slots — git (`31`), GNU ls (`01;34`), ripgrep — so
 * dropping them would strip nearly all color a shell actually produces.
 */
const SAFE_SGR_CODES: ReadonlySet<number> = new Set([
	// bold, dim, italic, underline, inverse, strike, overline
	1, 2, 3, 4, 7, 9, 53,
	// and their off-counterparts
	21, 22, 23, 24, 27, 29, 55,
	// default fg / bg
	39, 49,
	// basic fg / bg
	30, 31, 32, 33, 34, 35, 36, 37, 40, 41, 42, 43, 44, 45, 46, 47,
	// bright fg / bg
	90, 91, 92, 93, 94, 95, 96, 97, 100, 101, 102, 103, 104, 105, 106, 107,
]);

/**
 * Validates a parsed SGR parameter list, resolving the sub-arguments of extended
 * color so a channel value is never read as a standalone code — `38;2;227;148;0`
 * ends in a zero blue channel, not a reset.
 *
 * `allowReset` admits a top-level `0`. Callers that re-apply a base color on
 * reset must reject it, since replaying the reset verbatim would leave the rest
 * of the line at the terminal default.
 */
function isSafeSgr(codes: readonly number[], allowReset: boolean): boolean {
	let index = 0;
	while (index < codes.length) {
		const code = codes[index++];
		if (code === 0) {
			if (!allowReset) return false;
			continue;
		}
		if (code !== undefined && SAFE_SGR_CODES.has(code)) continue;
		if (code !== 38 && code !== 48) return false;
		const mode = codes[index++];
		if (mode === 5) {
			const color = codes[index++];
			if (color === undefined || color < 0 || color > 255) return false;
			continue;
		}
		if (mode !== 2) return false;
		for (let channel = 0; channel < 3; channel++) {
			const color = codes[index++];
			if (color === undefined || color < 0 || color > 255) return false;
		}
	}
	return true;
}

/**
 * Index of the last top-level reset in `codes`, or -1. Extended-color
 * sub-arguments are skipped, so a zero channel value is not mistaken for one.
 * Only valid on a list {@link isSafeSgr} already accepted — the skip widths
 * assume a well-formed `38`/`48` payload.
 */
function lastResetIndex(codes: readonly number[]): number {
	let last = -1;
	let index = 0;
	while (index < codes.length) {
		const code = codes[index++];
		if (code === 0) last = index - 1;
		else if (code === 38 || code === 48) index += codes[index] === 5 ? 2 : 4;
	}
	return last;
}

/** Applies the active tool-output color while preserving safe styles from a virtual terminal row. */
export function styleTerminalRow(row: string, baseForeground: string): string {
	let output = baseForeground;
	let offset = 0;
	let hasText = false;
	for (const match of row.matchAll(SGR)) {
		const index = match.index ?? 0;
		const text = sanitizeText(row.slice(offset, index));
		output += text;
		hasText ||= text.length > 0;

		const codes = match[1].split(";").map(Number);
		if (match[1] === "0") output += `${RESET}${baseForeground}`;
		else if (codes.length > 0 && codes.every(Number.isInteger) && isSafeSgr(codes, false)) output += match[0];
		offset = index + match[0].length;
	}
	const text = sanitizeText(row.slice(offset));
	output += text;
	hasText ||= text.length > 0;
	return hasText ? `${output}${RESET}` : "";
}

/**
 * Sanitizes text while keeping exactly the SGR sequences {@link styleTerminalRow}
 * is allowed to replay. Everything else — cursor movement, OSC, C0/C1 controls —
 * is dropped just as {@link sanitizeText} would.
 *
 * Used when colored command output is enabled: the output sink must not strip
 * the escapes before the transcript gets a chance to render them. `\x1b[m` and
 * `\x1b[0m` are both normalized to an explicit `0` reset so the renderer's
 * re-apply-base-color branch recognizes them.
 */
export function sanitizeTextKeepingSafeSgr(text: string): string {
	if (text.indexOf(ESC) === -1) return sanitizeText(text);

	let output = "";
	let offset = 0;
	for (const match of text.matchAll(SGR)) {
		const index = match.index ?? 0;
		output += sanitizeText(text.slice(offset, index));
		const params = match[1];
		if (params === "" || params === "0") output += RESET;
		else {
			const codes = params.split(";").map(Number);
			if (codes.every(Number.isInteger) && isSafeSgr(codes, true)) {
				// A reset inside a compound sequence (`0;31`) nullifies everything
				// before it. Split it out so the renderer's reset branch can re-apply
				// the base color instead of leaving the rest of the line unstyled.
				const reset = lastResetIndex(codes);
				if (reset !== -1) output += RESET;
				const styles = reset === -1 ? codes : codes.slice(reset + 1);
				if (styles.length > 0) output += `\x1b[${styles.join(";")}m`;
			}
		}
		offset = index + match[0].length;
	}
	return output + sanitizeText(text.slice(offset));
}

/** Reads terminal screen rows as sanitized text plus only the styles the TUI may replay. */
export function readTerminalRows(terminal: XtermTerminal, startRow: number, rowCount: number): string[] {
	const buffer = terminal.buffer.active;
	const reusableCell = buffer.getNullCell();
	const rows: string[] = [];
	const endRow = Math.min(buffer.length, Math.max(0, startRow) + Math.max(0, rowCount));

	for (let row = Math.max(0, startRow); row < endRow; row++) {
		const line = buffer.getLine(row);
		if (!line) {
			rows.push("");
			continue;
		}

		const cells: Array<{ chars: string; style: string }> = [];
		let lastContent = -1;
		for (let column = 0; column < line.length; ) {
			const cell = line.getCell(column, reusableCell);
			if (!cell) break;
			const chars = cell.getChars();
			const width = Math.max(1, cell.getWidth());
			cells.push({ chars: chars || " ", style: cellStyle(cell) });
			if (chars && chars !== " ") lastContent = cells.length - 1;
			column += width;
		}

		if (lastContent < 0) {
			rows.push("");
			continue;
		}

		let rendered = "";
		let previousStyle: string | undefined;
		for (let index = 0; index <= lastContent; index++) {
			const cell = cells[index]!;
			if (cell.style !== previousStyle) {
				rendered += `${RESET}${cell.style}`;
				previousStyle = cell.style;
			}
			rendered += cell.chars;
		}
		rows.push(rendered);
	}

	return rows;
}
