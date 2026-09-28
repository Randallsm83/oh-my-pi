import { type } from "@oh-my-pi/omptype";
import { type AdvisorSeverity, type AdvisorNote } from "@oh-my-pi/pi-tui/chat/messages";
export { type AdvisorSeverity, type AdvisorNote, type AdvisorMessageDetails } from "@oh-my-pi/pi-tui/chat/messages";
import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { escapeXmlAttribute, escapeXmlText, logger } from "@oh-my-pi/pi-utils";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };
import { AdvisorEmissionGuard, type AdvisorSuppressionReason } from "./emission-guard";

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = typeof adviseSchema.infer;

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
	/** Which configured advisor produced this note (omitted for the default advisor). */
	advisor?: string;
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as a
 * tag attribute (rather than a prose header) so the rendered agent-facing output
 * stays a clean `<advisory>` block. The primary agent's system prompt never
 * mentions advisories, so this is its only cue for how to treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[], opts?: { currentTurn?: number }): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			const age =
				opts?.currentTurn !== undefined && n.turn !== undefined && opts.currentTurn > n.turn
					? ` turns_ago="${opts.currentTurn - n.turn}"`
					: "";
			return `<advisory${who}${severity}${age} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

/**
 * Whether advice at this severity should interrupt the running agent (delivered
 * via the steering channel, aborting in-flight tools) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. `concern`
 * and `blocker` interrupt; a plain `nit` queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the primary
 *   is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` rides the non-interrupting aside queue while
 *   streaming, or is preserved as a visible card when idle after a terminal answer.
 * - An interrupting `concern`/`blocker` is normally steered into the agent: into
 *   the live turn while one is streaming, or (when idle) a triggered turn so the
 *   advice is acted on immediately.
 * - If the primary tail is already a terminal text answer and there is no queued
 *   work, late non-blocker advice (a `nit` or `concern`) is preserved as a visible
 *   card instead of waking the primary to restate completion. A `blocker` is the
 *   exception: it means the agent handed off broken or unexercised work, so it
 *   still steers a triggered turn to force the primary to acknowledge and continue
 *   before the turn is considered done (#5628) — deferring it to the next user
 *   turn is the bug.
 *   `allowTerminalConcernSteering` opts out of ONLY this preservation branch
 *   (a final-review continuation policy); stop/abort suppression, `preserveOnly`,
 *   and the immune-turn cooldown below still run first and are never bypassed.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor must
 *   not auto-resume the stopped run. While the agent is idle — or still tearing
 *   the interrupted turn down (`aborting`) — the note is preserved as a visible
 *   card instead of restarting the run. But once a turn is actively streaming
 *   again (a resume the user already drove), steering the note in does NOT
 *   auto-resume anything, so it is delivered live. Parking it during an active
 *   run instead strands it (it never reaches the running agent) and the withheld
 *   notes dump as one burst at the next user prompt — the bug this guards.
 * - Non-blocker advice from a review of an in-progress primary turn rides the
 *   non-interrupting aside queue while the loop is running, so it lands at the
 *   agent's next tool step instead of interrupting partial work. Once the loop
 *   has stopped, it takes the normal idle route. A `blocker` still steers.
 * - During the post-interrupt immune-turn window, further `concern` notes are
 *   downgraded to asides; preservation still wins. A `blocker` is exempt: it
 *   means the agent handed off broken or unexercised work, so it still steers a
 *   triggered turn even right after a prior interrupt (#5628).
 */
export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	/** Opt out of terminal-answer preservation for a late `concern` (default
	 *  false). Bypasses ONLY that branch — never stop/abort suppression,
	 *  `preserveOnly`, or the immune-turn cooldown. */
	allowTerminalConcernSteering?: boolean;
	interruptImmuneTurnActive?: boolean;
	inProgress?: boolean;
	preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
	if (opts.preserveOnly && !opts.streaming) return "preserve";
	if (
		opts.terminalAnswerNoQueuedWork &&
		opts.severity !== "blocker" &&
		!opts.allowTerminalConcernSteering &&
		!opts.streaming &&
		!opts.aborting
	)
		return "preserve";
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if ((opts.interruptImmuneTurnActive || (opts.inProgress && opts.streaming)) && opts.severity !== "blocker")
		return "aside";
	return "steer";
}

/**
 * Derive the advisor loop's telemetry from the primary session's config so the
 * advisor model's GenAI spans and usage/cost hooks (onChatUsage, onCostDelta,
 * costEstimator) fire under the same pipeline as every other model call —
 * stamped with the advisor's own agent identity. `conversationId` is cleared so
 * the advisor loop falls back to its own `-advisor` session id for
 * `gen_ai.conversation.id` instead of inheriting the primary's conversation.
 *
 * Returns undefined when the primary has no telemetry (instrumentation off), so
 * the advisor `Agent` stays a zero-overhead no-op as well.
 */
export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

/**
 * The tools an advisor receives by default when its config omits `tools` — the
 * read-only investigative set. The full available pool is every built tool the
 * session has (the advisor is a full agent); a config's `tools` selects from it.
 * The runtime build additionally admits `recall` into the default set when the
 * active memory backend built it (hindsight/mnemopi).
 */
export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

/** Rank advisor severities so the dedupe state can detect a real escalation
 *  (nit → concern → blocker) versus a verbatim repeat. `undefined` defers to
 *  `nit` because the schema treats an omitted severity as a plain nit. */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

/**
 * Merged-batch ordering: most recent turn first, then severity (blocker →
 * concern → nit) within a turn. The newest notes describe the latest state of
 * the work, so they read first; severity breaks ties so a blocker never hides
 * below a same-turn nit.
 */
export function compareAdvisorNotes(a: AdvisorNote, b: AdvisorNote): number {
	const turnDelta = (b.turn ?? 0) - (a.turn ?? 0);
	if (turnDelta !== 0) return turnDelta;
	return advisorSeverityRank(b.severity) - advisorSeverityRank(a.severity);
}

/** Admission acks: one line each — the advisor needs the verdict, not a policy essay. */
const ADVISOR_ACK_SENT = "Delivered.";
/** A suppressed note is never described as recorded or queued. */
const ADVISOR_ACK_SUPPRESSED: Record<AdvisorSuppressionReason, string> = {
	empty: "Dropped: empty note.",
	noise: "Dropped: nothing actionable.",
	duplicate: "Dropped: already raised.",
	"rate-limit": "Dropped: this update's advice budget is spent.",
};

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	/**
	 * Single admission authority for every emission: the guard decides whether
	 * a note routes or is suppressed.
	 */
	readonly #guard: AdvisorEmissionGuard;
	#inProgressUpdate = false;
	/** Primary-turn count the in-flight update reviews (stamped on emitted notes
	 *  so merged batches can report how stale each review was at delivery). */
	#coveredTurn: number | undefined;

	/**
	 * @param onAdvice Route an admitted note to the primary (channel selection +
	 *   delivery). Never re-filters — the note already cleared the guard.
	 *   `inProgress` is true when the note came from a review of an in-progress
	 *   primary turn, so non-blockers can be routed without interrupting.
	 * @param guard The admission authority: noise/empty/dedupe filter, rank-aware
	 *   escalation, and the per-update non-blocker budget. Defaults to a stock
	 *   {@link AdvisorEmissionGuard} (default budget
	 *   {@link ADVISOR_DEFAULT_BUDGET_PER_UPDATE}).
	 */
	constructor(
		private readonly onAdvice: (
			note: string,
			severity: AdviseDetails["severity"],
			inProgress: boolean,
			turn?: number,
		) => void,
		guard?: AdvisorEmissionGuard,
	) {
		this.#guard = guard ?? new AdvisorEmissionGuard();
	}

	/**
	 * Start one advisor update: resets the guard's per-update budget and marks
	 * whether the update reviews an in-progress primary turn.
	 */
	beginUpdate(inProgress: boolean, coveredTurn?: number): void {
		this.#inProgressUpdate = inProgress;
		this.#coveredTurn = coveredTurn;
		this.#guard.beginUpdate();
	}

	/** Clear all note state when the advisor starts a fresh conversation, so a
	 *  re-primed advisor can re-raise old issues. */
	resetDeliveredNotes(): void {
		this.#guard.reset();
		this.#inProgressUpdate = false;
	}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		const decision = this.#guard.admit(args.note, advisorSeverityRank(args.severity));
		if (!decision.accepted) {
			// A rejected note is never described as recorded or delivered.
			logger.debug("advisor advice suppressed by emission guard", {
				reason: decision.reason,
				severity: args.severity,
			});
			return this.#result(ADVISOR_ACK_SUPPRESSED[decision.reason ?? "duplicate"], args);
		}
		this.onAdvice(args.note, args.severity, this.#inProgressUpdate, this.#coveredTurn);
		return this.#result(ADVISOR_ACK_SENT, args);
	}


	#result(text: string, args: AdviseParams): AgentToolResult<AdviseDetails> {
		return {
			content: [{ type: "text", text }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}
