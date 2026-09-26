import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ADAPTERS, adapterFor } from "../extensions/limit-resume/adapters.ts";
import { checkResume, decide, formatLocalTime, GRACE_MS, INITIAL_RESUME_STATE, MAX_WAIT_MS, parseGrace, transition } from "../extensions/limit-resume/core.ts";

// Fixtures are sanitized provider error strings observed in real pi sessions. GLM error fixtures follow the official templates:
// https://docs.z.ai/api-reference/api-code and https://docs.bigmodel.cn/cn/api/api-code.
const now = Date.parse("2026-09-26T12:00:00Z");
const codex = ADAPTERS.find((adapter) => adapter.id === "codex")!;
const anthropic = ADAPTERS.find((adapter) => adapter.id === "anthropic")!;
const zai = ADAPTERS.find((adapter) => adapter.id === "zai")!;
const go = ADAPTERS.find((adapter) => adapter.id === "opencode-go")!;

function jwt(claims: unknown): string {
	const encoded = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `header.${encoded}.signature`;
}

function responseFetch(payload: unknown, status = 200) {
	return vi.fn(async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
}

function codexProbeRequest(fetch: typeof globalThis.fetch, baseUrl = "https://chatgpt.com/backend-api", token?: string) {
	return {
		token: token ?? jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" } }),
		baseUrl,
		fetch,
		signal: new AbortController().signal,
		now,
	};
}

function anthropicProbeRequest(fetch: typeof globalThis.fetch, baseUrl = "https://api.anthropic.com", options: { isOAuth?: boolean; token?: string } = {}) {
	return {
		token: options.token ?? "sk-ant-oat-fixture",
		baseUrl,
		fetch,
		signal: new AbortController().signal,
		now,
		...(options.isOAuth === undefined ? {} : { isOAuth: options.isOAuth }),
	};
}

describe("limit-resume classifiers", () => {
	it("classifies Codex messages, approximations, exclusions, and missing window metadata", () => {
		expect(codex.classify({ message: "Codex error: The usage limit has been reached", at: now })).toMatchObject({ window: "unknown", uncertaintyMs: 1_000 });
		expect(codex.classify({ message: "Codex usage limit reached (plus plan). Resets in ~42m. Current limit: 5h 100%, weekly 37%.", at: now }))
			.toMatchObject({ window: "5h", resetAt: now + 42 * 60_000, uncertaintyMs: 30_000 });
		expect(codex.classify({ message: "Codex usage limit reached. Resets in ~2.3h.", at: now }))
			.toMatchObject({ uncertaintyMs: 180_000, resetAt: now + 2.3 * 60 * 60_000 });
		expect(codex.classify({ message: "Codex usage limit reached. Resets in ~3h.", at: now }))
			.toMatchObject({ uncertaintyMs: 1_800_000 });
		expect(codex.classify({ message: "Codex usage limit reached. Resets in ~17 min.", at: now }))
			.toMatchObject({ uncertaintyMs: 30_000 });
		expect(codex.classify({ message: "Codex usage limit reached (plus plan). Resets in ~2.3h. Current limit: 5h 37%, weekly 100%.", at: now }))
			.toMatchObject({ window: "weekly" });
		expect(codex.classify({ message: "You have hit your ChatGPT usage limit (plus plan). Try again in ~17 min.", at: now }))
			.toMatchObject({ resetAt: now + 17 * 60_000 });
		expect(codex.classify({ message: "Codex error: Our servers are currently overloaded. Please try again later.", at: now })).toBeNull();
		expect(codex.classify({ message: "maximum context window reached", at: now })).toBeNull();
		expect(adapterFor("openrouter")).toBeUndefined();
		expect(codex.classify({ message: "429 TPM exceeded. Please try again in 8.76s", at: now })).toBeNull();
	});

	it("classifies Anthropic account subscription limits but excludes credits and bad requests", () => {
		const message = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_redacted"}';
		expect(anthropic.classify({ message, at: now })).toMatchObject({ window: "unknown" });
		expect(anthropic.classify({ message: '429 {"error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required"}}}', at: now })).toBeNull();
		expect(anthropic.classify({ message: '400 {"error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits."}}', at: now })).toBeNull();
	});

	it("classifies OpenCode Go relative reset durations", () => {
		expect(go.classify({ message: 'OpenAI API error (429): {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 2hr 53min. To continue..."}', at: now }))
			.toMatchObject({ window: "5h", resetAt: now + (2 * 60 + 53) * 60_000 });
		expect(go.classify({ message: '{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 41min"}', at: now }))
			.toMatchObject({ resetAt: now + 41 * 60_000 });
	});

	it("classifies sourced Z.ai/BigModel English and Chinese windows with UTC conversion", () => {
		const international = '429 {"error":{"code":"1308","message":"Usage limit reached for 5 hours. Your limit will reset at 2026-09-26 22:00:00"}}';
		expect(zai.classify({ message: international, at: now })).toMatchObject({ window: "5h", resetAt: Date.parse("2026-09-26T14:00:00Z") });
		const chinese = 'HTTP 429 {"error":{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-09-26 22:00:00 重置。"}}';
		expect(zai.classify({ message: chinese, at: now })).toMatchObject({ window: "5h", resetAt: Date.parse("2026-09-26T14:00:00Z") });
		const weekly = '429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-01T09:00:00+08:00"}}';
		expect(zai.classify({ message: weekly, at: now })).toMatchObject({ window: "weekly", resetAt: Date.parse("2026-10-01T01:00:00Z") });
		expect(zai.classify({ message: '429 {"error":{"code":"1305","message":"The service may be temporarily overloaded"}}', at: now })).toBeNull();
		expect(adapterFor("zai-coding-cn")).toBe(zai);
	});

	it("uses only a unique plausible timezone candidate for zoneless GLM resets", () => {
		const source = (reset: string) => `429 {"error":{"code":"1308","message":"Usage limit reached for 5 hours. Your limit will reset at ${reset}"}}`;
		const utcPlusEightOnly = now;
		expect(zai.classify({ message: source("2026-09-26 20:00:00"), at: utcPlusEightOnly }))
			.toMatchObject({ resetAt: Date.parse("2026-09-26T12:00:00Z") });
		const utcOnly = Date.parse("2026-09-26T10:00:00Z");
		expect(zai.classify({ message: source("2026-09-26 14:00:00"), at: utcOnly }))
			.toMatchObject({ resetAt: Date.parse("2026-09-26T14:00:00Z") });
		expect(zai.classify({ message: source("2026-09-27 23:00:00"), at: now })?.resetAt).toBeUndefined();
		const explicit = source("2026-09-26 20:00:00Z");
		expect(zai.classify({ message: explicit, at: now })).toMatchObject({ resetAt: Date.parse("2026-09-26T20:00:00Z") });
		const weekly = '429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-27 20:00:00"}}';
		const weeklySignal = zai.classify({ message: weekly, at: now })!;
		expect(weeklySignal).toMatchObject({ resetAt: Date.parse("2026-09-27T12:00:00Z"), resetTimeZone: "Asia/Shanghai" });
		const weeklyDecision = decide(weeklySignal, now);
		expect(weeklyDecision.kind).toBe("final");
		expect(weeklyDecision.reason).toContain(formatLocalTime(weeklySignal.resetAt!, "Asia/Shanghai", now));
	});
});

describe("reset time formatting", () => {
	const timeZone = "Asia/Tokyo";
	const now = Date.parse("2026-09-30T16:00:00Z");

	it("uses time only on the same local day and adds weekday/date on another day", () => {
		const sameDayReset = Date.parse("2026-10-01T02:00:00Z");
		const nextDayReset = Date.parse("2026-10-02T03:00:00Z");
		expect(formatLocalTime(sameDayReset, timeZone, now)).toBe(new Intl.DateTimeFormat(undefined, {
			hour: "numeric", minute: "2-digit", timeZone,
		}).format(sameDayReset));
		expect(formatLocalTime(nextDayReset, timeZone, now)).toBe(new Intl.DateTimeFormat(undefined, {
			weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone,
		}).format(nextDayReset));
	});
});

describe("usage probes", () => {
	it("builds absolute Codex GET URL on configured base URL origin and reports parsed usage", async () => {
		const fetch = responseFetch({ rate_limit: {
			primary_window: { used_percent: 37, window_minutes: 300, resets_at: now / 1000 + 3_000 },
			secondary_window: { used_percent: 12, window_minutes: 10_080, resets_at: now / 1000 + 86_400 },
		} });
		const result = await codex.probe!(codexProbeRequest(fetch, "https://usage.example.test/backend/v1"));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]![0]).toBe("https://usage.example.test/backend/v1/wham/usage");
		expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
		expect(result).toMatchObject({ window: "unknown", evidence: expect.stringContaining("Codex 5h 37%") });
		expect(result?.evidence).toContain("weekly 12%");
	});

	it("prefers exhausted Codex weekly windows and latest reset across all exhausted 5h windows", async () => {
		const fetch = responseFetch({
			rate_limit: { primary_window: { used_percent: 100, window_minutes: 300, resets_at: now / 1000 + 300 } },
			additional_rate_limits: [
				{ metered_feature: "model-a", limit_name: "extra-a", rate_limit: { primary_window: { used_percent: 100, window_minutes: 300, resets_at: now / 1000 + 900 } } },
				{ metered_feature: "model-b", limit_name: "extra-b", rate_limit: { primary_window: { used_percent: 100, window_minutes: 300, resets_at: now / 1000 + 600 } } },
			],
		});
		expect(await codex.probe!(codexProbeRequest(fetch))).toMatchObject({ window: "5h", resetAt: now + 900_000 });

		const weeklyFetch = responseFetch({
			rate_limit: { primary_window: { used_percent: 100, window_minutes: 300, resets_at: now / 1000 + 300 } },
			additional_rate_limits: [{ metered_feature: "model-a", rate_limit: { primary_window: { used_percent: 100, window_minutes: 10_080, resets_at: now / 1000 + 86_400 } } }],
		});
		expect(await codex.probe!(codexProbeRequest(weeklyFetch))).toMatchObject({ window: "weekly" });
	});

	it("returns informative unknown for available Codex usage and null for unreadable responses", async () => {
		const fetch = responseFetch({ rate_limit: { primary_window: { used_percent: 24, window_minutes: 300, resets_at: now / 1000 + 3_000 } } });
		const result = await codex.probe!(codexProbeRequest(fetch));
		expect(result?.window).toBe("unknown");
		expect(result?.resetAt).toBeUndefined();
		expect(result?.evidence).toContain("24%");
		expect(await codex.probe!(codexProbeRequest(responseFetch({}, 429)))).toBeNull();
		expect(await codex.probe!(codexProbeRequest(responseFetch("not json")))).toBeNull();
		const exhaustedWithoutReset = await codex.probe!(codexProbeRequest(responseFetch({ rate_limit: { primary_window: { used_percent: 100, window_minutes: 300 } } })));
		expect(exhaustedWithoutReset?.window).toBe("unknown");
		expect(exhaustedWithoutReset?.resetAt).toBeUndefined();
	});

	it("builds absolute Anthropic GET URL on configured origin and returns informative usage", async () => {
		const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-ant-oat-fixture");
			expect(new Headers(init?.headers).get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(new Headers(init?.headers).get("user-agent")).toBe("pi-limit-resume/0.1");
			return new Response(JSON.stringify({ five_hour: { utilization: 37, resets_at: "2026-09-26T13:00:00Z" }, seven_day: { utilization: 12, resets_at: "2026-10-01T00:00:00Z" } }));
		}) as typeof globalThis.fetch;
		const result = await anthropic.probe!(anthropicProbeRequest(fetch, "https://oauth.example.test/custom/v1"));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]![0]).toBe("https://oauth.example.test/api/oauth/usage");
		expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
		expect(result).toMatchObject({ window: "unknown" });
		expect(result?.evidence).toContain("five_hour 37%");
	});

	it("classifies every Anthropic weekly bucket before 5h and handles non-200/malformed results", async () => {
		const both = responseFetch({ five_hour: { utilization: 100, resets_at: "2026-09-26T13:00:00Z" }, seven_day: { utilization: 100, resets_at: "2026-10-01T00:00:00Z" } });
		expect(await anthropic.probe!(anthropicProbeRequest(both))).toMatchObject({ window: "weekly" });
		const modelWeekly = responseFetch({ seven_day: { utilization: 99 }, seven_day_opus: { utilization: 100, resets_at: "2026-10-01T00:00:00Z" } });
		expect(await anthropic.probe!(anthropicProbeRequest(modelWeekly))).toMatchObject({ window: "weekly" });
		const available = await anthropic.probe!(anthropicProbeRequest(responseFetch({ five_hour: { utilization: 37, resets_at: "2026-09-26T13:00:00Z" }, seven_day: { utilization: 12 } })));
		expect(available).toMatchObject({ window: "unknown" });
		expect(available?.evidence).toContain("five_hour 37%");
		expect(await anthropic.probe!(anthropicProbeRequest(responseFetch(null)))).toBeNull();
		expect(await anthropic.probe!(anthropicProbeRequest(responseFetch({ five_hour: { utilization: 100 } }, 401)))).toBeNull();
	});

	it("prefers modelRegistry OAuth indication, falls back to token prefix, and never exposes tokens", async () => {
		const rejectedFetch = vi.fn() as typeof fetch;
		expect(await anthropic.probe!(anthropicProbeRequest(rejectedFetch, "https://api.anthropic.com", { isOAuth: false }))).toBeNull();
		expect(rejectedFetch).not.toHaveBeenCalled();
		const oauthFetch = responseFetch({ five_hour: { utilization: 100, resets_at: "2026-09-26T13:00:00Z" } });
		const token = "sk-ant-oat-fixture-secret-marker";
		const signal = await anthropic.probe!(anthropicProbeRequest(oauthFetch, "https://api.anthropic.com", { isOAuth: true, token }));
		expect(signal?.window).toBe("5h");
		expect(JSON.stringify(signal)).not.toContain(token);
		expect(await anthropic.probe!(anthropicProbeRequest(rejectedFetch, "https://api.anthropic.com", { token: "sk-ant-api-key" }))).toBeNull();
	});
});

describe("decision policy", () => {
	const signal = { window: "5h" as const, resetAt: now + 60_000, uncertaintyMs: 1_000, evidence: "test" };

	it("waits until reset plus uncertainty and grace, including past resets", () => {
		expect(decide(signal, now, 60_000)).toEqual({ kind: "wait", resumeAt: now + 121_000 });
		expect(decide({ ...signal, resetAt: now - 5_000 }, now, 60_000)).toEqual({ kind: "wait", resumeAt: now + 61_000 });
	});

	it("finalizes unknown reset, weekly windows, and waits beyond maximum", () => {
		expect(decide({ ...signal, resetAt: undefined }, now)).toMatchObject({ kind: "final", reason: "usage limit, reset time unknown" });
		expect(decide({ ...signal, window: "weekly" }, now).reason).toContain("weekly limit, not auto-continuing");
		expect(decide({ ...signal, resetAt: now + MAX_WAIT_MS }, now)).toMatchObject({ kind: "final", reason: "reset too far" });
	});

	it("transitions through one bounded wait and one resume-success guard", () => {
		const target = { provider: "openai-codex", model: "gpt-test", sessionId: "s1", entryId: "e1" };
		const waiting = transition(INITIAL_RESUME_STATE, { type: "wait", target, signal, resumeAt: now + 1_000 });
		expect(waiting).toMatchObject({ kind: "waiting", target, resumeAt: now + 1_000, resumedAwaitingProgress: false });
		expect(transition(waiting, { type: "wait", target: { ...target, entryId: "e2" }, signal, resumeAt: now + 2_000 })).toBe(waiting);
		const resumed = transition(waiting, { type: "auto-resumed" });
		expect(resumed).toEqual({ kind: "idle", resumedAwaitingProgress: true });
		expect(transition(resumed, { type: "success" })).toBe(INITIAL_RESUME_STATE);
		expect(transition(waiting, { type: "cancel" })).toBe(INITIAL_RESUME_STATE);
	});

	it("validates configured grace values and policy constants", () => {
		expect(parseGrace(undefined)).toBe(60_000);
		expect(parseGrace("0")).toBe(0);
		expect(parseGrace("1200")).toBe(1_200);
		expect(parseGrace("-1")).toBe(60_000);
		expect(parseGrace("bad")).toBe(60_000);
		expect(GRACE_MS).toBeGreaterThanOrEqual(0);
		expect(MAX_WAIT_MS).toBe(5 * 60 * 60_000 + 15 * 60_000);
	});
});

describe("fire-time resume guard", () => {
	const target = { provider: "openai-codex", model: "gpt-test", sessionId: "s1", entryId: "e1" };
	const live = { sessionId: "s1", latestEntryId: "e1", provider: "openai-codex", model: "gpt-test", idle: true, pendingMessages: false };

	it("allows only the exact session, conversation position, model, and an idle session", () => {
		expect(checkResume(target, live)).toBeUndefined();
		expect(checkResume(target, { ...live, sessionId: "s2" })).toBe("session changed");
		expect(checkResume(target, { ...live, latestEntryId: "e2" })).toContain("conversation moved");
		expect(checkResume(target, { ...live, latestEntryId: undefined })).toContain("conversation moved");
		expect(checkResume(target, { ...live, model: "gpt-reserve" })).toBe("model changed from openai-codex/gpt-test to openai-codex/gpt-reserve");
		expect(checkResume(target, { ...live, provider: undefined, model: undefined })).toContain("to none/none");
		expect(checkResume(target, { ...live, idle: false })).toBe("session busy");
		expect(checkResume(target, { ...live, pendingMessages: true })).toBe("session busy");
		// Identity failures win over transient busy state.
		expect(checkResume(target, { ...live, model: "other", idle: false })).toContain("model changed");
	});
});

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("probe redirect policy", () => {
	it("never follows a redirect to another origin, so credentials never leave the configured origin", async () => {
		const foreignRequests: { url: string; authorization?: string; account?: string }[] = [];
		const foreign = createServer((request, response) => {
			foreignRequests.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
				account: request.headers["chatgpt-account-id"] as string | undefined,
			});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ five_hour: { utilization: 100, resets_at: new Date(Date.now() + 60_000).toISOString() } }));
		});
		const foreignPort = await listen(foreign);
		const configuredRequests: string[] = [];
		const configured = createServer((request, response) => {
			configuredRequests.push(request.url ?? "");
			response.writeHead(302, { location: `http://127.0.0.1:${foreignPort}${request.url ?? "/"}` });
			response.end();
		});
		const configuredPort = await listen(configured);
		const base = `http://127.0.0.1:${configuredPort}`;
		const claims = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-redirect" } }))
			.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
		try {
			const anthropicResult = await anthropic.probe!({
				token: "sk-ant-oat-redirect-secret",
				baseUrl: base,
				fetch: globalThis.fetch,
				signal: AbortSignal.timeout(5_000),
				now: Date.now(),
				isOAuth: true,
			});
			const codexResult = await codex.probe!({
				token: `x.${claims}.x`,
				baseUrl: `${base}/backend-api`,
				fetch: globalThis.fetch,
				signal: AbortSignal.timeout(5_000),
				now: Date.now(),
			});
			expect(configuredRequests).toEqual(["/api/oauth/usage", "/backend-api/wham/usage"]);
			expect(anthropicResult).toBeNull();
			expect(codexResult).toBeNull();
			expect(foreignRequests).toEqual([]);
		} finally {
			await Promise.all([close(foreign), close(configured)]);
		}
	});
});
