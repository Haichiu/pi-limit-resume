import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import limitResume from "../extensions/limit-resume/index.ts";
import { decide, GRACE_MS, TICK_MS } from "../extensions/limit-resume/core.ts";
import { adapterFor } from "../extensions/limit-resume/adapters.ts";

const START = Date.parse("2026-09-26T12:00:00Z");
const GO_LIMIT = 'OpenAI API error (429): {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 1min"}';
const ANTHROPIC_LIMIT = '429 {"error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

interface TestMessage {
	role: string;
	provider?: string;
	model?: string;
	stopReason: string;
	errorMessage?: string;
}

interface TestModel {
	provider: string;
	id: string;
	baseUrl?: string;
}

const GO_MODEL: TestModel = { provider: "opencode-go", id: "fixture", baseUrl: "https://opencode.ai" };
const ANTHROPIC_MODEL: TestModel = { provider: "anthropic", id: "fixture", baseUrl: "https://api.anthropic.com" };

function harness(options: { hasUI?: boolean; authToken?: string; model?: TestModel } = {}) {
	const listeners = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const notifications: { message: string; type?: string }[] = [];
	const statuses: [string, string | undefined][] = [];
	const sent: string[] = [];
	let branch: { type: string; id: string; message?: TestMessage }[] = [];
	let idle = true;
	let pendingMessages = false;
	let model: TestModel | undefined = options.model ?? GO_MODEL;
	let sessionId = "session-1";
	let disposed = false;
	const assertActive = () => {
		if (disposed) throw new Error("extension runtime disposed");
	};
	const token = options.authToken ?? "sk-ant-oat-test-secret";
	const registry = {
		getProviderAuth: vi.fn(async () => options.authToken ? { auth: { apiKey: token, baseUrl: "https://api.anthropic.com" } } : undefined),
		getApiKeyForProvider: vi.fn(async () => options.authToken),
		isUsingOAuth: vi.fn(() => true),
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
		},
		// Live getter, like Pi's runtime context: reflects model changes made after the event.
		get model() {
			assertActive();
			return model;
		},
		modelRegistry: registry,
		sessionManager: {
			// Pi returns a fresh array; the extension must not depend on mutating it.
			getBranch: () => {
				assertActive();
				return [...branch];
			},
			getSessionId: () => {
				assertActive();
				return sessionId;
			},
		},
		isIdle: () => {
			assertActive();
			return idle;
		},
		hasPendingMessages: () => {
			assertActive();
			return pendingMessages;
		},
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, listener: (event: any, ctx: ExtensionContext) => unknown) => { listeners.set(name, listener); },
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => { commands.set(name, command); },
		sendUserMessage: (message: string) => sent.push(message),
	} as unknown as ExtensionAPI;
	limitResume(api);
	return {
		ctx,
		listeners,
		commands,
		notifications,
		statuses,
		sent,
		registry,
		token,
		setBranch(messages: TestMessage[]) { branch = messages.map((message, index) => ({ type: "message", id: `e${index}`, message })); },
		setIdle(value: boolean) { idle = value; },
		setPendingMessages(value: boolean) { pendingMessages = value; },
		setModel(value: TestModel | undefined) { model = value; },
		setSessionId(value: string) { sessionId = value; },
		dispose() { disposed = true; },
		async emit(name: string, event: any = {}) { return await listeners.get(name)?.(event, ctx); },
		async command(args: string) { return await commands.get("limit-resume")!.handler(args, ctx as ExtensionCommandContext); },
	};
}

function limitMessage(provider = "opencode-go"): TestMessage {
	return { role: "assistant", provider, model: "fixture", stopReason: "error", errorMessage: GO_LIMIT };
}

function anthropicLimit(): TestMessage {
	return { role: "assistant", provider: "anthropic", model: "fixture", stopReason: "error", errorMessage: ANTHROPIC_LIMIT };
}

/** Lets queued promise continuations run (fake timers are active) until `done` holds or a small bound is hit. */
async function flushUntil(done: () => boolean): Promise<void> {
	for (let step = 0; step < 50 && !done(); step++) await vi.advanceTimersByTimeAsync(0);
}

async function beginWait(h: ReturnType<typeof harness>): Promise<number> {
	h.setBranch([limitMessage()]);
	await h.emit("agent_settled");
	const adapter = adapterFor("opencode-go")!;
	const signal = adapter.classify({ message: GO_LIMIT, at: Date.now() })!;
	const decision = decide(signal, Date.now(), GRACE_MS);
	if (decision.kind !== "wait") throw new Error("fixture must wait");
	return decision.resumeAt;
}

async function finishWait(h: ReturnType<typeof harness>, resumeAt: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(resumeAt - Date.now());
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("limit-resume extension state machine", () => {
	it("waits until the decided wall-clock deadline, sends exactly one continue, and clears status", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.message).toContain("/limit-resume cancel");
		expect(h.statuses.some(([key, value]) => key === "limit-resume" && value !== undefined)).toBe(true);
		await vi.advanceTimersByTimeAsync(resumeAt - Date.now() - 1);
		expect(h.sent).toEqual([]);
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual(["continue"]);
		expect(h.statuses.at(-1)).toEqual(["limit-resume", undefined]);
		expect(h.notifications).toHaveLength(2);
	});

	it("does not cancel on extension input, but cancels on interactive or RPC input", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		await h.emit("input", { text: "extension follow-up", source: "extension" });
		await vi.advanceTimersByTimeAsync(TICK_MS);
		expect(h.sent).toEqual([]);
		await h.emit("input", { text: "new user request", source: "interactive" });
		expect(h.notifications.at(-1)?.message).toContain("cancelled");
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
	});

	it("reports status and supports /limit-resume cancel without sending a continuation", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		await h.command("");
		expect(h.notifications.at(-1)?.message).toContain("waiting for opencode-go");
		await h.command("status");
		expect(h.notifications.at(-1)?.message).toContain("waiting for opencode-go");
		await h.command("cancel");
		expect(h.notifications.at(-1)?.message).toBe("Limit resume cancelled.");
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
	});

	it("ignores an old assistant limit error when the latest message is from the user", async () => {
		const h = harness();
		h.setBranch([limitMessage(), { role: "user", stopReason: "stop" }]);
		await h.emit("agent_settled");
		expect(h.sent).toEqual([]);
		expect(h.notifications).toEqual([]);
		expect(h.statuses).toEqual([]);
	});

	it("cancels when an unrelated agent run starts", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		await h.emit("agent_start");
		expect(h.notifications.at(-1)?.message).toContain("another agent run started");
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
	});

	it("notifies once and never loops when the resumed run hits the limit again", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		await finishWait(h, resumeAt);
		const before = h.notifications.length;
		h.setBranch([limitMessage()]);
		await h.emit("agent_settled");
		expect(h.sent).toEqual(["continue"]);
		expect(h.notifications).toHaveLength(before + 1);
		expect(h.notifications.at(-1)).toMatchObject({ type: "error", message: "Still limited after auto-continue; not retrying again." });
	});

	it("clears the one-shot guard on success, allowing a later independent wait", async () => {
		const h = harness();
		const firstResumeAt = await beginWait(h);
		await finishWait(h, firstResumeAt);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		h.setBranch([limitMessage()]);
		await h.emit("agent_settled");
		expect(h.notifications.at(-1)?.message).toContain("Usage limit detected");
		expect(h.sent).toEqual(["continue"]);
	});

	it("clears the timer on shutdown", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		await h.emit("session_shutdown");
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
		expect(h.notifications).toHaveLength(1);
	});

	it.each([
		["not idle", false, false],
		["pending messages", true, true],
	])("does not resume when the session is busy (%s)", async (_label, idle, hasPending) => {
		const h = harness();
		const resumeAt = await beginWait(h);
		h.setIdle(idle);
		h.setPendingMessages(hasPending);
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
		expect(h.notifications.at(-1)?.message).toContain("session busy, not resumed");
	});

	it("checks wall clock again after a sleep/wake jump and sends only once", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		vi.setSystemTime(resumeAt + 60 * 60_000);
		await vi.advanceTimersByTimeAsync(TICK_MS);
		expect(h.sent).toEqual(["continue"]);
		await vi.advanceTimersByTimeAsync(TICK_MS * 5);
		expect(h.sent).toEqual(["continue"]);
	});

	it("probes an OAuth provider once using modelRegistry auth and never surfaces the token", async () => {
		const token = "sk-ant-oat-never-display-this";
		const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
			return new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: new Date(START + 300_000).toISOString() } }));
		}) as typeof globalThis.fetch;
		vi.stubGlobal("fetch", fetch);
		const h = harness({ authToken: token, model: ANTHROPIC_MODEL });
		h.setBranch([anthropicLimit()]);
		await h.emit("agent_settled");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(h.registry.getProviderAuth).toHaveBeenCalledWith("anthropic");
		expect(h.registry.isUsingOAuth).toHaveBeenCalledTimes(1);
		expect(h.notifications.some(({ message }) => message.includes(token))).toBe(false);
		expect(h.statuses.some(([, value]) => value?.includes(token))).toBe(false);
	});

	it("runs the current model probe from /limit-resume probe without exposing the token", async () => {
		const token = "sk-ant-oat-never-display-this";
		const fetch = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 37, resets_at: new Date(START + 300_000).toISOString() } }))) as typeof globalThis.fetch;
		vi.stubGlobal("fetch", fetch);
		const h = harness({ authToken: token, model: ANTHROPIC_MODEL });
		await h.command("probe");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(h.notifications.at(-1)?.message).toContain("Probe: unknown");
		expect(h.notifications.at(-1)?.message).not.toContain(token);
	});

	it("uses the classifier if a probe fails and makes one final unknown-reset notice", async () => {
		const token = "sk-ant-oat-never-display-this";
		vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof globalThis.fetch);
		const h = harness({ authToken: token, model: ANTHROPIC_MODEL });
		h.setBranch([anthropicLimit()]);
		await h.emit("agent_settled");
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0]?.message).toContain("reset time unknown");
		expect(h.notifications[0]?.message).not.toContain(token);
		expect(h.statuses).toEqual([["limit-resume", undefined]]);
	});

	it("does nothing without UI and ignores non-limit errors", async () => {
		const noUi = harness({ hasUI: false });
		noUi.setBranch([limitMessage()]);
		await noUi.emit("agent_settled");
		expect(noUi.notifications).toEqual([]);
		expect(noUi.statuses).toEqual([]);
		expect(noUi.sent).toEqual([]);

		const other = harness();
		other.setBranch([{ role: "assistant", provider: "openrouter", stopReason: "error", errorMessage: "429 TPM exceeded" }]);
		await other.emit("agent_settled");
		expect(other.notifications).toEqual([]);
		expect(other.statuses).toEqual([]);
	});
});

describe("limit-resume boundary regressions (peer review 2026-09-26)", () => {
	it("/limit-resume cancel during a pending usage probe never arms a wait and aborts the request", async () => {
		let release: ((response: Response) => void) | undefined;
		let probeSignal: AbortSignal | undefined;
		const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
			probeSignal = init?.signal ?? undefined;
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		}) as unknown as typeof globalThis.fetch;
		vi.stubGlobal("fetch", fetch);
		const h = harness({ authToken: "sk-ant-oat-test", model: ANTHROPIC_MODEL });
		h.setBranch([anthropicLimit()]);
		const settling = h.emit("agent_settled");
		await flushUntil(() => release !== undefined);
		expect(fetch).toHaveBeenCalledTimes(1);
		await h.command("status");
		expect(h.notifications.at(-1)?.message).toContain("checking usage for anthropic/fixture");
		await h.command("cancel");
		expect(h.notifications.at(-1)?.message).toBe("Limit resume cancelled.");
		expect(probeSignal?.aborted).toBe(true);
		release!(new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: new Date(START + 60_000).toISOString() } })));
		await settling;
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(h.sent).toEqual([]);
		expect(h.notifications.some(({ message }) => message.includes("Usage limit detected"))).toBe(false);
		expect(h.statuses.filter(([, value]) => value !== undefined)).toEqual([]);
	});

	it("a model change cancels an armed wait; re-selecting the same model does not", async () => {
		const same = harness();
		const sameResumeAt = await beginWait(same);
		await same.emit("model_select", { model: GO_MODEL, previousModel: GO_MODEL, source: "set" });
		await finishWait(same, sameResumeAt);
		expect(same.sent).toEqual(["continue"]);

		const h = harness();
		const resumeAt = await beginWait(h);
		const other = { provider: "opencode-go", id: "other" };
		h.setModel(other);
		await h.emit("model_select", { model: other, previousModel: GO_MODEL, source: "cycle" });
		expect(h.notifications.at(-1)?.message).toBe("Limit resume cancelled: model changed to opencode-go/other.");
		expect(h.statuses.at(-1)).toEqual(["limit-resume", undefined]);
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
	});

	it("/tree navigation (session_tree) cancels an armed wait in the same session runtime", async () => {
		const h = harness();
		const resumeAt = await beginWait(h);
		await h.emit("session_tree", { oldLeafId: "e0", newLeafId: "elsewhere" });
		expect(h.notifications.at(-1)?.message).toBe("Limit resume cancelled: conversation branch changed.");
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
	});

	it.each([
		["the model changed without an event", (h: ReturnType<typeof harness>) => h.setModel({ provider: "opencode-go", id: "other" }), "model changed from opencode-go/fixture to opencode-go/other"],
		["the conversation moved without an event", (h: ReturnType<typeof harness>) => h.setBranch([limitMessage(), { role: "user", stopReason: "stop" }]), "conversation moved"],
		["the session id changed", (h: ReturnType<typeof harness>) => h.setSessionId("session-2"), "session changed"],
	])("the fire-time guard blocks the continuation when %s", async (_label, mutate, reason) => {
		const h = harness();
		const resumeAt = await beginWait(h);
		mutate(h);
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
		expect(h.notifications.at(-1)?.message).toContain(reason);
		expect(h.notifications.at(-1)?.message).toContain("not resumed");
	});

	it("does not arm when the current model already differs from the model that hit the limit", async () => {
		const h = harness({ model: { provider: "opencode-go", id: "reserve" } });
		h.setBranch([limitMessage()]);
		await h.emit("agent_settled");
		expect(h.notifications.at(-1)?.message).toContain("current model is opencode-go/reserve; not auto-continuing");
		expect(h.statuses.filter(([, value]) => value !== undefined)).toEqual([]);
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(h.sent).toEqual([]);
	});

	it("stops quietly (no continuation, no throw) if the runtime context is disposed before the deadline", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const h = harness();
		const resumeAt = await beginWait(h);
		h.dispose();
		await finishWait(h, resumeAt);
		expect(h.sent).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[limit-resume] stopped"));
		warn.mockRestore();
	});
});
