import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveAdvisorDeliveryChannel } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isAdvisorCard } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { fixedAdvisorTools } from "./helpers/agent-session-setup";

const NOTE = "mid-run concern: reuse the existing helper";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part =>
			part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
		)
		.join("\n");
}

const stepTool: AgentTool<any, any, any> = {
	name: "step",
	label: "step",
	description: "step test tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text", text: "step complete" }] }),
};

let active: { session: AgentSession; auth: AuthStorage; temp: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp.remove().catch(() => {});
	active = undefined;
});

/**
 * Run a primary agent whose first turn does not end the run (`firstTurn`) and
 * whose second request gives the final answer, with an advisor that answers its
 * in-progress review with one advisory. The run is held until the advisory is
 * accepted, so the result says exactly where it landed:
 * - `turn-end`: held at the first turn's end, before asides fold into the next request;
 * - `next-request`: held inside the second request, after that fold.
 */
async function runWithMidRunAdvisory(
	firstTurn: MockResponse,
	{
		severity = "concern",
		holdAt = "turn-end",
	}: { severity?: "nit" | "concern"; holdAt?: "turn-end" | "next-request" } = {},
) {
	const temp = TempDir.createSync("@pi-advisor-mid-run-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const adviceAccepted = Promise.withResolvers<string>();
	const primaryContexts: string[] = [];
	let advisorCalls = 0;

	const primaryMock = createMockModel({
		id: "mid-run-primary",
		provider: "anthropic",
		handler: () => (primaryContexts.length === 1 ? firstTurn : { content: ["done"], stopReason: "stop" }),
	});
	const advisorMock = createMockModel({
		id: "mid-run-advisor",
		provider: "anthropic",
		handler: () =>
			++advisorCalls === 1
				? {
						content: [{ type: "toolCall", id: "advice-1", name: "advise", arguments: { note: NOTE, severity } }],
						stopReason: "toolUse",
					}
				: { content: ["advisor quiet"], stopReason: "stop" },
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["mid-run advisor delivery"], tools: [stepTool] },
		// The session's converter, as in production: agent-core's default drops advisor cards.
		convertToLlm,
		streamFn: async (model, context, options) => {
			primaryContexts.push(JSON.stringify(context.messages));
			if (holdAt === "next-request" && primaryContexts.length === 2) await adviceAccepted.promise;
			return primaryMock.stream(model, context, options);
		},
	});
	const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	let held = false;
	agent.setOnTurnEnd = callback => {
		if (!callback) return originalSetOnTurnEnd(undefined);
		originalSetOnTurnEnd(async (messages, signal, context) => {
			await callback(messages, signal, context);
			// The loop awaits this hook before folding asides into the next request.
			if (holdAt === "turn-end" && context?.willContinue === true && !held) {
				held = true;
				await adviceAccepted.promise;
			}
		});
	};

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "off",
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: fixedAdvisorTools(),
		advisorStreamFn: advisorMock.stream,
	});
	active = { session, auth, temp };
	if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
	const advise = session.getAdvisorAgent()?.state.tools.find(tool => tool.name === "advise");
	if (!advise) throw new Error("Expected advise tool");
	const originalExecute = advise.execute.bind(advise);
	advise.execute = async (...args) => {
		const result = await originalExecute(...args);
		adviceAccepted.resolve(contentText(result.content));
		return result;
	};

	await session.prompt("do the task");
	await session.waitForIdle();
	const cards = session.agent.state.messages.filter(isAdvisorCard);
	return { acknowledgement: await adviceAccepted.promise, primaryContexts, cards };
}

describe("advisor advisories during an in-progress primary turn", () => {
	it("reach the primary agent's next request after a tool step, without an extra turn", async () => {
		const { acknowledgement, primaryContexts } = await runWithMidRunAdvisory({
			content: [{ type: "toolCall", id: "step-1", name: "step", arguments: {} }],
			stopReason: "toolUse",
		});

		expect(acknowledgement).toMatch(/Delivered/);
		expect(primaryContexts).toHaveLength(2);
		expect(primaryContexts[1]).toContain(NOTE);
	});

	it("reach the continuation request of a pause_turn instead of waiting for the next run", async () => {
		const { primaryContexts } = await runWithMidRunAdvisory({
			content: ["Scanning the repo first."],
			stopReason: "stop",
			stopDetails: { type: "pause_turn" },
		});

		expect(primaryContexts).toHaveLength(2);
		expect(primaryContexts[1]).toContain(NOTE);
	});

	it("stay a visible card when still queued at the final answer, without waking the agent again", async () => {
		const { primaryContexts, cards } = await runWithMidRunAdvisory(
			{ content: [{ type: "toolCall", id: "step-1", name: "step", arguments: {} }], stopReason: "toolUse" },
			{ severity: "nit", holdAt: "next-request" },
		);

		expect(primaryContexts).toHaveLength(2);
		expect(primaryContexts[1]).not.toContain(NOTE);
		expect(cards.map(card => contentText(card.content)).join("\n")).toContain(NOTE);
	});
});

describe("resolveAdvisorDeliveryChannel for an in-progress review", () => {
	it("routes a concern to the next step without interrupting, but steers a blocker", () => {
		const base = {
			continueSeverity: "blocker" as const,
			autoResumeSuppressed: false,
			streaming: true,
			aborting: false,
			inProgress: true,
		};
		expect(resolveAdvisorDeliveryChannel({ ...base, severity: "concern" })).toBe("aside");
		expect(resolveAdvisorDeliveryChannel({ ...base, severity: "blocker" })).toBe("steer");
		// The same concern from a completed-turn review still interrupts.
		expect(resolveAdvisorDeliveryChannel({ ...base, severity: "concern", inProgress: false })).toBe("steer");
		// A late in-progress concern after the final answer stays a card.
		expect(
			resolveAdvisorDeliveryChannel({
				...base,
				severity: "concern",
				streaming: false,
				terminalAnswerNoQueuedWork: true,
			}),
		).toBe("preserve");
		// The loop stopped without a final answer (error, length): an aside would sit
		// unread until the next prompt, so the concern takes the idle steer route.
		expect(resolveAdvisorDeliveryChannel({ ...base, severity: "concern", streaming: false })).toBe("steer");
	});
});
