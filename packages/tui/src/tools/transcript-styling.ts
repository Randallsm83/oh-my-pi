/**
 * Transcript styling: the subset of a command's own colors and text styles that
 * survives into the transcript (see `bash.color`).
 *
 * Every surface that shows stored shell output (the bash tool card, the user
 * command block, the bash renderer) goes through this module, so which escapes
 * survive and how resets fall back to the theme are decided once:
 * - {@link prepareTranscriptOutput} cleans stored output for display;
 * - {@link styleTranscriptLine} paints a prepared row over a theme base color.
 * Output without escapes renders byte-identical to a flat `theme.fg(...)`.
 */
import { sanitizeWithOptionalSixelPassthrough } from "../render/sixel";
import type { Theme, ThemeColor } from "../theme/theme";
import { sanitizeTextKeepingSafeSgr, styleTerminalRow } from "./terminal-output";

/**
 * Clean stored command output for display: keep the safe styling subset with
 * resets normalized for {@link styleTranscriptLine}, drop every other control
 * sequence, and keep SIXEL payloads when passthrough is enabled.
 */
export function prepareTranscriptOutput(text: string): string {
	return sanitizeWithOptionalSixelPassthrough(text, sanitizeTextKeepingSafeSgr);
}

/**
 * Paint one prepared row. A row carrying styling keeps it, replayed over the
 * theme base so a mid-line reset returns to the theme color rather than the
 * terminal default; a plain row takes the flat theme color.
 */
export function styleTranscriptLine(line: string, theme: Theme, color: ThemeColor = "toolOutput"): string {
	return line.includes("\x1b") ? styleTerminalRow(line, theme.getFgAnsi(color)) : theme.fg(color, line);
}
