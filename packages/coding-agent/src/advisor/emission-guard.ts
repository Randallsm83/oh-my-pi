/**
 * Per-session policy gate for advisor `advise()` calls.
 *
 * The advisor system prompt tells the watcher model a per-update advice budget
 * (default 4 non-blockers, `blocker` exempt):
 *
 * > max N non-blockers/update (`blocker` exempt)
 * > NEVER repeat advice you already gave, and NEVER send the same advice twice
 *
 * Real advisor models violate this. Issue #3520 captured a session where
 * `__advisor.jsonl` recorded 309 `advise` calls covering 92 unique notes —
 * 114× `Stop.`, 52× `No issue; continue.`, 41× `Done.` — flooding the primary
 * transcript with `<advisory severity="blocker">Stop.</advisory>` after the
 * task was already complete. The fix is to make the rules load-bearing in code
 * instead of prose: drop duplicates, content-free self-talk, and over-budget
 * calls at the `AdviseTool` admission boundary so the primary stays clean even when
 * the advisor misbehaves.
 *
 * The guard is the single admission authority: every decision carries a
 * truthful {@link AdvisorSuppressionReason} that `AdviseTool` surfaces
 * verbatim in its acknowledgment — a rejected note is never described as
 * recorded, and a rate-limited note is never mislabeled a duplicate.
 */

/**
 * Case-insensitive, punctuation-folded normalization. Collapses every run of
 * non-letter / non-digit characters into a single space and trims, so
 * `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`, while
 * `"No issue; continue."` keys to `no issue continue`.
 *
 * Exported for tests.
 */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Normalized phrases the advisor occasionally emits that carry no concrete
 * actionable content. Each must be the output of {@link normalizeAdvisorNote}
 * so a single membership check covers every punctuation/casing variant
 * (`"Stop."`, `"stop"`, `"STOP!"`).
 *
 * The list is conservative — only short, content-free filler the reporter
 * observed driving primary-transcript pollution. A genuine `blocker` like
 * `"Stop: 'await' missing on writeStream.end() will lose buffered writes."`
 * does not match.
 */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	// Self-stop noise — telling the agent to "stop" without a reason is useless.
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	// Completion self-talk — the agent already finished the task.
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	// "Nothing to flag" — silence is the correct expression of "no concerns".
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	// Endorsements — equivalent to silence.
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

/**
 * Bounds the dedupe history. Sessions with very long advisor activity could
 * otherwise grow the set without bound. The reporter's pathological session
 * had 92 unique notes; 4096 leaves headroom while staying tiny (≤ ~256 KB of
 * normalized strings even at long max).
 */
const DEFAULT_HISTORY_CAPACITY = 4096;

/** Maximum non-blocker advise notes allowed per update cycle across all configurations. */
export const ADVISOR_MAX_BUDGET_PER_UPDATE = 32;

/** Default non-blocker advise notes allowed per update cycle when unspecified. */
export const ADVISOR_DEFAULT_BUDGET_PER_UPDATE = 4;

/** Why the guard suppressed a note. Surfaced verbatim in the tool acknowledgment. */
export type AdvisorSuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit";

/**
 * The guard's admission decision for one `advise()` call — the single source
 * of truth `AdviseTool` acts on; the tool never re-infers eviction or
 * suppression policy from its own state.
 */
export interface AdvisorAdmission {
	/** Whether the note may reach the primary. */
	accepted: boolean;
	/** Why a suppressed note was rejected. Set only when `accepted` is false. */
	reason?: AdvisorSuppressionReason;
}

/**
 * Decides whether an advisor `advise()` call should reach the primary agent.
 *
 * Enforces — in this order — the noise filter, session-scoped rank-aware
 * dedupe (FIFO-evicted at {@link DEFAULT_HISTORY_CAPACITY}), and a per-update
 * budget of admitted non-blocker notes. Suppressed calls never consume the
 * budget — a noise call doesn't burn the slot for a real concern that follows
 * in the same update. A `blocker` is exempt from the budget: it must always
 * interrupt, so a lower-severity note emitted earlier in the same update can
 * never rate-limit it out.
 *
 * Dedupe is rank-aware: re-raising the same text at a strictly higher
 * severity is a real escalation (nit → concern → blocker), not a repeat, and
 * is admitted — an already-delivered nit re-raised as a blocker still
 * interrupts. Equal or lower severity re-raises stay suppressed, so an
 * advisor cannot bypass dedupe by retagging the same text sideways.
 *
 * When the budget is full, further non-blockers in the same update are
 * rate-limited: every admitted note routes immediately, and a delivery cannot
 * be retracted to free a slot.
 *
 * Reset on advisor reset (compaction, session switch, `/new`) via
 * {@link reset}. Per-update budget is cleared at the start of every advisor
 * `agent.prompt()` cycle via {@link beginUpdate} (driven by
 * `AdviseTool.beginUpdate`).
 */
export class AdvisorEmissionGuard {
	/** Normalized key → highest admitted severity rank this session. A new call
	 *  passes only when its rank strictly exceeds the recorded one (a real
	 *  escalation), so equal/lower retags of the same text stay suppressed. */
	#seen = new Map<string, number>();
	/** Insertion-order log to drive FIFO eviction without a second Map. Keys are
	 *  pushed on first admission only; escalations update the rank in place. */
	#seenOrder: string[] = [];
	/** Normalized keys charged against this update's budget (size ≤ #budgetPerUpdate). */
	#slots = new Set<string>();
	readonly #capacity: number;
	readonly #budgetPerUpdate: number;

	constructor(opts: { capacity?: number; budgetPerUpdate?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
		const budget = opts.budgetPerUpdate;
		this.#budgetPerUpdate =
			typeof budget === "number" && Number.isFinite(budget)
				? Math.min(ADVISOR_MAX_BUDGET_PER_UPDATE, Math.max(1, Math.trunc(budget)))
				: ADVISOR_DEFAULT_BUDGET_PER_UPDATE;
	}

	/**
	 * Drop all dedupe and per-update state. Called when the advisor runtime is
	 * reset — same boundary as `yieldQueue.clear("advisor")`, so a re-primed
	 * advisor can re-raise old issues (the primary transcript was rewritten).
	 * Driven by `AdviseTool.resetDeliveredNotes()`.
	 */
	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#slots.clear();
	}

	/**
	 * Clear the per-update budget. Called at the start of every advisor
	 * `agent.prompt()` cycle (via `AdviseTool.beginUpdate`) so the next advisor
	 * model cycle starts with a fresh budget.
	 */
	beginUpdate(): void {
		this.#slots.clear();
	}

	/**
	 * Record the highest admitted rank for a key, FIFO-bounding the history:
	 * first-seen keys enter the eviction queue and the oldest entry is dropped
	 * beyond {@link #capacity}.
	 */
	#recordRank(key: string, rank: number): void {
		const isNew = !this.#seen.has(key);
		this.#seen.set(key, rank);
		if (!isNew) return;
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
	}

	/**
	 * Decide whether the proposed note may reach the primary. The decision is
	 * the single admission authority: on `accepted` the guard has recorded the
	 * note (consumed budget where due, updated the dedupe rank); on rejection
	 * the `reason` is the truthful classification for the advisor-facing
	 * acknowledgment.
	 *
	 * A note that fails the noise/empty/dedupe filter never consumes the
	 * budget, so a suppressed phrase cannot burn the update's slot ahead of a
	 * substantive concern. Empty / whitespace-only notes are suppressed
	 * defensively even though the tool-args contract requires a non-empty string.
	 */
	admit(note: string, rank: number): AdvisorAdmission {
		const key = normalizeAdvisorNote(note);
		if (!key) return { accepted: false, reason: "empty" };
		if (SUPPRESSED_NORMALIZED_PHRASES[key]) return { accepted: false, reason: "noise" };
		const seenRank = this.#seen.get(key) ?? 0;
		if (rank <= seenRank) return { accepted: false, reason: "duplicate" };
		// Admitted: a fresh note, or a strictly-higher-rank re-raise of an
		// already-admitted note (a real escalation). Blockers are exempt from the
		// budget; a same-update escalation of an already-charged note (a routed
		// nit re-raised as a concern) reuses its slot instead of charging a second.
		if (rank < 3 && !this.#slots.has(key)) {
			if (this.#slots.size >= this.#budgetPerUpdate) return { accepted: false, reason: "rate-limit" };
			this.#slots.add(key);
		}
		this.#recordRank(key, rank);
		return { accepted: true };
	}
}
