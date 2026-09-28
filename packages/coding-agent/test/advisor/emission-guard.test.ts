import { describe, expect, it } from "bun:test";
import { AdvisorEmissionGuard, normalizeAdvisorNote } from "../../src/advisor/emission-guard";

describe("normalizeAdvisorNote", () => {
	it("collapses punctuation, casing, and surrounding whitespace into one canonical key", () => {
		// The reporter's three top duplicates all key to the same canonical form
		// regardless of trailing punctuation or casing — that's what makes the
		// dedupe + suppression checks single-membership.
		expect(normalizeAdvisorNote("Stop.")).toBe("stop");
		expect(normalizeAdvisorNote("  STOP!  ")).toBe("stop");
		expect(normalizeAdvisorNote("*Stop*")).toBe("stop");
		expect(normalizeAdvisorNote("Done.")).toBe("done");
		expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue");
	});

	it("returns empty string for whitespace-only input so callers can short-circuit", () => {
		expect(normalizeAdvisorNote("")).toBe("");
		expect(normalizeAdvisorNote("   ")).toBe("");
		expect(normalizeAdvisorNote("...")).toBe("");
	});

	it("preserves internal letters/digits but folds non-alphanumeric runs to one space", () => {
		expect(normalizeAdvisorNote("Refactor `auth-flow.ts`: drop legacy branch.")).toBe(
			"refactor auth flow ts drop legacy branch",
		);
	});
});

describe("AdvisorEmissionGuard", () => {
	it("drops the exact content-free filler the reporter observed flooding the chat", () => {
		// Issue #3520: 114× "Stop.", 52× "No issue; continue.", 41× "Done." —
		// none of these carry a concrete reason and they cannot be acted on, so
		// the guard suppresses them regardless of severity.
		const guard = new AdvisorEmissionGuard();
		for (const note of ["Stop.", "Done.", "No issue; continue.", "LGTM", "No further watcher input needed."]) {
			expect(guard.admit(note, 1)).toEqual({ accepted: false, reason: "noise" });
		}
	});

	it("dedupes by normalized text across the session, ignoring casing and trailing punctuation", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.admit("Move retries into the queue, not the request path.", 1)).toEqual({
			accepted: true,
		});
		// Same advice with different casing and trailing punctuation must NOT
		// land twice in the primary transcript.
		expect(guard.admit("move retries into the queue, not the request path", 1)).toEqual({
			accepted: false,
			reason: "duplicate",
		});
		expect(guard.admit("Move retries into the queue, not the request path!", 1)).toEqual({
			accepted: false,
			reason: "duplicate",
		});
	});

	it("limits each update to four non-blockers by default", () => {
		// #3520's anti-flood clamp lives beside the upstream default: four
		// distinct notes from one advisor cycle are fine; the fifth is the flood.
		const guard = new AdvisorEmissionGuard();
		for (let i = 1; i <= 4; i++) {
			expect(guard.admit(`Distinct concern ${i}.`, 2).accepted).toBe(true);
		}
		expect(guard.admit("Distinct concern 5.", 2)).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
		guard.beginUpdate();
		// New cycle: budget reset.
		expect(guard.admit("Distinct concern 5.", 2).accepted).toBe(true);
	});

	it("rate-limits a second distinct non-blocker per update under an explicit budget of 1", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("First concern: missing await in #handleRetry.", 2)).toEqual({
			accepted: true,
		});
		expect(guard.admit("Second concern: wrong env var name.", 2)).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("does not let a suppressed call consume the per-update budget", () => {
		// A noise call like "Stop." must never displace a real concern that
		// follows in the same advisor model cycle.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Stop.", 2)).toEqual({ accepted: false, reason: "noise" });
		expect(guard.admit("Concrete: read race in #handleRetry.", 2).accepted).toBe(true);
	});

	it("does not let a deduped call consume the per-update budget", () => {
		// A repeat of a prior session note is dropped, but the model can still
		// follow it with a fresh concrete concern in the same cycle.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Concrete: read race in #handleRetry.", 2).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("Concrete: read race in #handleRetry.", 2)).toEqual({
			accepted: false,
			reason: "duplicate",
		});
		expect(guard.admit("New concern: cache eviction never fires.", 2).accepted).toBe(true);
	});

	it("lets any number of blockers through while non-blockers share the budget", () => {
		// The per-update budget exists to stop nit/concern floods (#3520). A
		// blocker reports broken handoff — losing it because a concern was emitted
		// first in the same cycle loses the one note that must always land.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Concern: only one of three reads done.", 2)).toEqual({
			accepted: true,
		});
		expect(guard.admit("Blocker: the run stopped before the third read.", 3)).toEqual({
			accepted: true,
		});
		expect(guard.admit("Blocker: the diff was never exercised end to end.", 3)).toEqual({
			accepted: true,
		});
		// The budget is still spent for non-blockers.
		expect(guard.admit("Nit: consider a shorter loop.", 1)).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
		// Noise and dedupe still apply to blockers.
		expect(guard.admit("Blocker: the run stopped before the third read.", 3)).toEqual({
			accepted: false,
			reason: "duplicate",
		});
	});

	it("rate-limits a higher-severity newcomer once the budget is spent — delivery cannot be retracted", () => {
		// A note already routed to the primary keeps its slot: a later concern
		// in the same update must not create an over-budget second delivery by
		// "evicting" a delivery that already happened.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Nit: rename the helper.", 1)).toEqual({ accepted: true });
		expect(guard.admit("Concern: the helper drops the lock early.", 2)).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("admits a same-text blocker escalation of an already-routed note without reopening budget", () => {
		// The production failure: a delivered nit re-raised as a blocker must
		// still interrupt — dedupe is rank-aware, not a hard text wall. The
		// routed slot stays charged (no retraction), the blocker is exempt, and
		// equal/lower retags afterwards stay suppressed.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		const note = "The migration drops the users table without a backup.";
		expect(guard.admit(note, 1)).toEqual({ accepted: true });
		expect(guard.admit("THE MIGRATION DROPS THE USERS TABLE WITHOUT A BACKUP!", 3)).toEqual({ accepted: true });
		expect(guard.admit(note, 2)).toEqual({ accepted: false, reason: "duplicate" });
		expect(guard.admit(note, 1)).toEqual({ accepted: false, reason: "duplicate" });
	});

	it("treats a same-update severity re-raise of a routed note as one charged slot", () => {
		// The same text at higher severity is the same note reclassified, not a
		// second note: the slot upgrades in place instead of double-charging.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 2 });
		const note = "The helper drops the lock early.";
		expect(guard.admit(note, 1)).toEqual({ accepted: true });
		expect(guard.admit(note, 2)).toEqual({ accepted: true });
		// Only one of the two budget slots was spent.
		expect(guard.admit("Distinct nit: naming.", 1)).toEqual({ accepted: true });
		expect(guard.admit("Distinct nit: formatting.", 1)).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("reset clears dedupe and the per-update gate so a re-primed advisor can re-raise old issues", () => {
		// Compaction / session-switch rewrites the primary transcript. The
		// advisor is re-primed from scratch and may legitimately re-raise the
		// same concerns — they're new context for a freshly-primed reviewer.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("Race in #handleRetry.", 2).accepted).toBe(true);
		expect(guard.admit("Race in #handleRetry.", 2).accepted).toBe(false);
		guard.reset();
		expect(guard.admit("Race in #handleRetry.", 2).accepted).toBe(true);
	});

	it("evicts oldest entries when dedupe history exceeds capacity", () => {
		// Bounded so very long sessions cannot grow the dedupe state without
		// bound. Pre-eviction unique notes are remembered; post-eviction the
		// oldest one is forgotten and can resurface.
		const guard = new AdvisorEmissionGuard({ capacity: 3 });
		expect(guard.admit("first", 1).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("second", 1).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("third", 1).accepted).toBe(true);
		guard.beginUpdate();
		// "first" still in history.
		expect(guard.admit("first", 1).accepted).toBe(false);
		guard.beginUpdate();
		// Fourth unique entry evicts "first".
		expect(guard.admit("fourth", 1).accepted).toBe(true);
		guard.beginUpdate();
		expect(guard.admit("first", 1).accepted).toBe(true);
	});

	it("rejects empty / whitespace-only notes without consuming the budget", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("", 1)).toEqual({ accepted: false, reason: "empty" });
		expect(guard.admit("   ", 1)).toEqual({ accepted: false, reason: "empty" });
		expect(guard.admit("Concrete advice.", 1).accepted).toBe(true);
	});

	it("end-to-end: the reporter's 309-call spam log yields a single unique note", () => {
		// Mimic the issue's distribution: 114× "Stop.", 52× "No issue; continue.",
		// 41× "Done.", plus 102 copies of one concrete-but-repeated nit. Spread
		// the calls across 50 advisor update cycles. Noise phrases never pass;
		// identical-text repeats never escape the session dedupe. After all
		// calls, exactly the concrete nit has been admitted — and only once.
		const guard = new AdvisorEmissionGuard();
		const accepted: string[] = [];
		const stream: string[] = [
			...Array(114).fill("Stop."),
			...Array(52).fill("No issue; continue."),
			...Array(41).fill("Done."),
			...Array(102).fill("Concrete-but-repeated nit: x"),
		];
		// Interleave across 50 update cycles.
		const cycles = 50;
		const perCycle = Math.ceil(stream.length / cycles);
		for (let c = 0; c < cycles; c++) {
			guard.beginUpdate();
			for (let i = 0; i < perCycle; i++) {
				const note = stream[c * perCycle + i];
				if (note === undefined) break;
				if (guard.admit(note, 1).accepted) accepted.push(note);
			}
		}
		expect(accepted).toEqual(["Concrete-but-repeated nit: x"]);
	});
});
