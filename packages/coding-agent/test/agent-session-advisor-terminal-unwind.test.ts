import { afterEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isAdvisorCard } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { TempDir } from "@oh-my-pi/pi-utils";

const boundaryToolSchema = type({});
type BoundaryTool = AgentTool<typeof boundaryToolSchema, undefined>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, args: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join("\n");
}

function makeTool(name: string, execute: BoundaryTool["execute"]): BoundaryTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: boundaryToolSchema,
		execute,
	};
}

let active: { session: AgentSession; auth: AuthStorage; temp: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp.remove().catch(() => {});
	active = undefined;
});

it.each([
	{
		severity: "concern",
		continueSeverity: "blocker",
		continues: false,
		continuation: undefined,
		immuneTurns: undefined,
		stop: false,
		liveDelivery: "next-user",
	},
	{
		severity: "nit",
		continueSeverity: undefined,
		continues: false,
		continuation: undefined,
		immuneTurns: undefined,
		stop: false,
		liveDelivery: "next-user",
	},
	{
		severity: "concern",
		continueSeverity: undefined,
		continues: true,
		continuation: "nit",
		immuneTurns: undefined,
		stop: false,
		liveDelivery: "next-user",
	},
	...(
		[
			{ continuation: "concern", immuneTurns: undefined, liveDelivery: "next-user" },
			{ continuation: "nit", immuneTurns: undefined, liveDelivery: "next-user" },
			{ continuation: "blocker", immuneTurns: undefined, liveDelivery: "same-run" },
			{ continuation: "concern", immuneTurns: 0, liveDelivery: "same-run" },
			{ continuation: "nit", immuneTurns: 0, liveDelivery: "next-user" },
			{ continuation: "blocker", immuneTurns: 0, liveDelivery: "same-run" },
		] as const
	).map(row => ({
		...row,
		severity: "blocker" as const,
		continueSeverity: undefined,
		continues: true,
		stop: false,
	})),
	{
		severity: "blocker",
		continueSeverity: "nit",
		continues: true,
		continuation: "nit",
		immuneTurns: 0,
		stop: false,
		liveDelivery: "same-run",
	},
	{
		severity: "blocker",
		continueSeverity: undefined,
		continues: true,
		continuation: "concern",
		immuneTurns: undefined,
		stop: true,
		liveDelivery: "next-user",
	},
] as const)(
	"delivers terminal and continuation notes once under severity, cooldown, and stop policy %j",
	async ({ severity, continueSeverity, continues, continuation, immuneTurns, stop, liveDelivery }) => {
		const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const nextUserMarker = "NEXT_USER_CONTEXT_MARKER";
		const terminalTurnEnd = Promise.withResolvers<void>();
		const advisorStarted = Promise.withResolvers<void>();
		const releaseAdvisor = Promise.withResolvers<void>();
		const adviceAccepted = Promise.withResolvers<boolean>();
		const continuationStarted = Promise.withResolvers<void>();
		const releaseContinuation = Promise.withResolvers<void>();
		const continuationMarker = `CONTINUATION_${continuation}_${immuneTurns ?? "default"}_${stop}`;
		const nextProviderStarted = Promise.withResolvers<void>();
		const releaseNextProvider = Promise.withResolvers<void>();
		const primaryContexts: string[] = [];
		let advisorCalls = 0;
		let stepRequested = false;
		let terminalAnswered = false;
		let continuationHeld = false;
		let nextProviderHeld = false;
		let terminalReleaseStarted = false;

		const primaryMock = createMockModel({
			id: "terminal-unwind-primary",
			provider: "anthropic",
			handler: async () => {
				if (primaryContexts.at(-1)?.includes(nextUserMarker)) {
					if (!nextProviderHeld) {
						nextProviderHeld = true;
						nextProviderStarted.resolve();
						await releaseNextProvider.promise;
						return toolResponse("next-step", "step");
					}
					return textResponse("next answer");
				}
				if (!stepRequested) {
					stepRequested = true;
					return toolResponse("step-1", "step");
				}
				if (!terminalAnswered) {
					terminalAnswered = true;
					return textResponse("terminal answer");
				}
				if (continues && !continuationHeld) {
					continuationHeld = true;
					continuationStarted.resolve();
					await releaseContinuation.promise;
				}
				return textResponse("continuation answer");
			},
		});
		const advisorMock = createMockModel({
			id: "terminal-unwind-advisor",
			provider: "anthropic",
			handler: async () => {
				if (++advisorCalls === 1) {
					advisorStarted.resolve();
					await releaseAdvisor.promise;
					return toolResponse("advice-1", "advise", {
						note: "late terminal advice",
						severity,
					});
				}
				return textResponse("advisor quiet");
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["terminal unwind regression"],
				tools: [makeTool("step", async () => ({ content: [{ type: "text", text: "step complete" }] }))],
			},
			convertToLlm,
			streamFn: (messages, context, options) => {
				primaryContexts.push(JSON.stringify(context.messages));
				return primaryMock.stream(messages, context, options);
			},
		});
		const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
		agent.setOnTurnEnd = callback => {
			if (!callback) {
				originalSetOnTurnEnd(undefined);
				return;
			}
			originalSetOnTurnEnd(async (messages, signal, context) => {
				await callback(messages, signal, context);
				if (context?.willContinue === false && !terminalReleaseStarted) {
					terminalReleaseStarted = true;
					terminalTurnEnd.resolve();
					releaseAdvisor.resolve();
					await adviceAccepted.promise;
				}
			});
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "off",
			...(immuneTurns === 0 ? { "advisor.immuneTurns": 0 } : {}),
			...(continueSeverity ? { "advisor.continueSeverity": continueSeverity } : {}),
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		active = { session, auth, temp };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
		let agentStarts = 0;
		session.subscribe(event => {
			if (event.type === "agent_start") agentStarts++;
		});
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advise tool");
		const originalExecute = advise.execute.bind(advise);
		advise.execute = async (...args) => {
			const result = await originalExecute(...args);
			adviceAccepted.resolve(agent.state.isStreaming);
			return result;
		};

		try {
			const run = session.prompt("run a step then finish");
			await advisorStarted.promise;
			await terminalTurnEnd.promise;
			expect(await adviceAccepted.promise).toBe(true);
			if (continuation) {
				await continuationStarted.promise;
				// Settle the completed review before accepting another note, without
				// confusing its tool-response follow-up with a new advisor update.
				expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
				expect(agent.state.isStreaming).toBe(true);
				expect(agentStarts).toBe(1);
				expect(primaryContexts.at(-1)).not.toContain(continuationMarker);
				if (stop) {
					const aborted = session.abort({ reason: USER_INTERRUPT_LABEL });
					releaseContinuation.resolve();
					await aborted;
				}
				await advise.execute("live-continuation", { note: continuationMarker, severity: continuation });
				await advise.execute("duplicate-continuation", { note: continuationMarker, severity: continuation });
				releaseContinuation.resolve();
			}
			await run;
			await session.waitForIdle();
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
			expect(primaryContexts.some(context => context.includes("late terminal advice"))).toBe(continues);
			expect(agentStarts).toBe(1);
			expect(
				advisor.state.messages.some(message => message.role === "toolResult" && message.toolCallId === "advice-1"),
			).toBe(true);
			if (continuation) {
				const consumers = primaryContexts.filter(context => context.includes(continuationMarker));
				expect(consumers).toHaveLength(liveDelivery === "same-run" ? 1 : 0);
				const cardText = agent.state.messages
					.filter(isAdvisorCard)
					.map(card => contentText(card.content))
					.join("\n");
				expect(cardText.split(continuationMarker)).toHaveLength(2);
			}
			if (!continues) {
				const cards = agent.state.messages.filter(isAdvisorCard);
				expect(cards).toHaveLength(1);
				expect(contentText(cards[0]?.content)).toContain("late terminal advice");
			}

			const beforeNextUser = primaryContexts.length;
			const nextRun = session.prompt(nextUserMarker);
			await nextProviderStarted.promise;
			expect(session.agent.state.isStreaming).toBe(true);
			await advise.execute("live-next", {
				note: "live next-turn concern",
				severity: "concern",
			});
			releaseNextProvider.resolve();
			await nextRun;
			await session.waitForIdle();
			expect(agentStarts).toBe(2);
			const nextUserContexts = primaryContexts.slice(beforeNextUser);
			expect(nextUserContexts[0]).toContain(nextUserMarker);
			expect(nextUserContexts[0]?.split("late terminal advice")).toHaveLength(2);
			expect(nextUserContexts.at(-1)?.split("live next-turn concern")).toHaveLength(2);
			if (continuation) {
				expect(nextUserContexts[0]?.split(continuationMarker)).toHaveLength(2);
				for (const context of primaryContexts) {
					expect(context.split(continuationMarker).length).toBeLessThanOrEqual(2);
				}
				const cards = agent.state.messages.filter(isAdvisorCard);
				expect(
					cards
						.map(card => contentText(card.content))
						.join("\n")
						.split(continuationMarker),
				).toHaveLength(2);
			}
		} finally {
			releaseAdvisor.resolve();
			adviceAccepted.resolve(false);
			releaseContinuation.resolve();
			releaseNextProvider.resolve();
		}
	},
);

// Regression: a qualifying `nit` that lands after the boundary window closed,
// while the core loop still reports streaming, must take the same latched
// continuation as a boundary-flush steer. Routed as an aside it was drained by
// the loop's yield point into an extra turn the advisor then reviewed again.
it("continues once on a late nit at advisor.continueSeverity=nit without re-reviewing the continuation", async () => {
	const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const lateNote = "LATE_NIT_MARKER";
	const primaryContexts: string[] = [];
	let reviewStarts = 0;
	let streamingAtNote: boolean | undefined;

	const primaryMock = createMockModel({
		id: "terminal-unwind-primary",
		provider: "anthropic",
		responses: [textResponse("terminal answer"), textResponse("continuation answer")],
		handler: () => textResponse("unexpected extra turn"),
	});
	const advisorMock = createMockModel({
		id: "terminal-unwind-advisor",
		provider: "anthropic",
		handler: () => textResponse("advisor quiet"),
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["terminal unwind regression"], tools: [] },
		convertToLlm,
		streamFn: (messages, context, options) => {
			primaryContexts.push(JSON.stringify(context.messages));
			return primaryMock.stream(messages, context, options);
		},
	});
	const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	agent.setOnTurnEnd = callback => {
		if (!callback) {
			originalSetOnTurnEnd(undefined);
			return;
		}
		originalSetOnTurnEnd(async (messages, signal, context) => {
			await callback(messages, signal, context);
			// The advisors' boundary window has closed; the loop has not yet yielded.
			if (context?.willContinue === false && streamingAtNote === undefined) {
				streamingAtNote = agent.state.isStreaming;
				const advise = session.getAdvisorAgent()?.state.tools.find(tool => tool.name === "advise");
				await advise?.execute("late-nit", { note: lateNote, severity: "nit" });
			}
		});
	};

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "off",
		"advisor.continueSeverity": "nit",
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [],
		advisorStreamFn: (advisorModel, context, options) => {
			if (context.messages.at(-1)?.role === "user") reviewStarts++;
			return advisorMock.stream(advisorModel, context, options);
		},
	});
	active = { session, auth, temp };
	if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");

	await session.prompt("answer in one line");
	await session.waitForIdle();
	expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

	expect(streamingAtNote).toBe(true);
	expect(primaryContexts).toHaveLength(2);
	expect(primaryContexts[1]).toContain(lateNote);
	// Only the user-started turn is reviewed; the advisor-started continuation is not.
	expect(reviewStarts).toBe(1);
});

it.each([
	{ boundary: "final", severity: "concern", continueSeverity: undefined, consumes: true },
	{ boundary: "final", severity: "concern", continueSeverity: "blocker", consumes: false },
	{ boundary: "final", severity: "nit", continueSeverity: "nit", consumes: true },
	{ boundary: "final", severity: "nit", continueSeverity: undefined, consumes: false },
	{ boundary: "pause_turn", severity: "concern", continueSeverity: "blocker", consumes: true },
	{ boundary: "pause_turn", severity: "nit", continueSeverity: "blocker", consumes: true },
] as const)(
	"consumes queued advice once at a working pause or qualifying terminal continuation %j",
	async ({ boundary, severity, continueSeverity, consumes }) => {
		const temp = TempDir.createSync("@pi-advisor-queued-unwind-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const note = "QUEUED_THRESHOLD_NOTE";
		const companionNote = "QUEUED_COMPANION_NOTE";
		const nextUser = "QUEUED_NEXT_USER";
		const firstRequestStarted = Promise.withResolvers<void>();
		const releaseFirstRequest = Promise.withResolvers<void>();
		const primaryContexts: string[] = [];
		let reviewStarts = 0;
		const primaryMock = createMockModel({
			id: "queued-unwind-primary",
			provider: "anthropic",
			handler: async () => {
				if (primaryContexts.length !== 1) return textResponse("finished");
				firstRequestStarted.resolve();
				await releaseFirstRequest.promise;
				return boundary === "pause_turn"
					? { content: ["still working"], stopReason: "stop", stopDetails: { type: "pause_turn" } }
					: textResponse("terminal answer");
			},
		});
		const advisorMock = createMockModel({
			id: "queued-unwind-advisor",
			provider: "anthropic",
			handler: () => textResponse("advisor quiet"),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["queued advisor continuation"], tools: [] },
			convertToLlm,
			streamFn: (messages, context, options) => {
				primaryContexts.push(JSON.stringify(context.messages));
				return primaryMock.stream(messages, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "off",
			...(continueSeverity ? { "advisor.continueSeverity": continueSeverity } : {}),
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: (advisorModel, context, options) => {
				if (context.messages.at(-1)?.role === "user") reviewStarts++;
				return advisorMock.stream(advisorModel, context, options);
			},
		});
		active = { session, auth, temp };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");

		try {
			const run = session.prompt("finish this task");
			await firstRequestStarted.promise;
			// Exercise the registered consumer of already-admitted asides, independent
			// of whether an advisor update still holds an in-progress reservation.
			session.yieldQueue.enqueue("advisor", { note, severity });
			session.yieldQueue.enqueue("advisor", { note: companionNote, severity: "nit" });
			expect(agent.hasQueuedMessages()).toBe(false);
			releaseFirstRequest.resolve();
			await run;
			await session.waitForIdle();
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

			expect(primaryContexts[0]).not.toContain(note);
			if (consumes) {
				expect(primaryContexts[1]?.split(note)).toHaveLength(2);
				expect(primaryContexts[1]?.split(companionNote)).toHaveLength(2);
			} else {
				expect(primaryContexts.some(context => context.includes(note))).toBe(false);
				expect(primaryContexts.some(context => context.includes(companionNote))).toBe(false);
			}
			if (boundary === "final") {
				// A queue-started continuation is captured but never schedules a review.
				expect(reviewStarts).toBe(1);
			}
			const cards = agent.state.messages.filter(isAdvisorCard);
			expect(cards).toHaveLength(1);
			expect(contentText(cards[0]?.content).split(note)).toHaveLength(2);
			expect(contentText(cards[0]?.content).split(companionNote)).toHaveLength(2);

			const beforeNextUser = primaryContexts.length;
			await session.prompt(nextUser);
			await session.waitForIdle();
			const nextContext = primaryContexts[beforeNextUser];
			expect(nextContext).toContain(nextUser);
			expect(nextContext?.split(note)).toHaveLength(2);
			expect(nextContext?.split(companionNote)).toHaveLength(2);
			expect(agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		} finally {
			releaseFirstRequest.resolve();
		}
	},
);
