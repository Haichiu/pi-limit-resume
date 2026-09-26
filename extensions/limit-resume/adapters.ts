import { MAX_WAIT_MS, type LimitAdapter, type LimitSignal, type ProbeRequest, formatLocalTime } from "./core.js";

const EXACT_MS = 1_000;
const CODEX_DEFAULT_BASE = "https://chatgpt.com/backend-api";
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

interface UsageWindow {
	usedPercent?: number;
	windowMinutes?: number;
	resetAt?: number;
}

interface WindowReport {
	label: string;
	window: UsageWindow;
}

function makeSignal(
	window: LimitSignal["window"],
	evidence: string,
	resetAt?: number,
	uncertaintyMs = EXACT_MS,
): LimitSignal {
	return { window, evidence, uncertaintyMs, ...(resetAt === undefined ? {} : { resetAt }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonError(message: string): Record<string, unknown> | undefined {
	const start = message.indexOf("{");
	if (start < 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(message.slice(start));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function durationMs(value: string): number | undefined {
	const pattern = /([0-9]+(?:[.][0-9]+)?)[ ]*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)/gi;
	let total = 0;
	let found = false;
	for (const match of value.matchAll(pattern)) {
		found = true;
		const amount = Number(match[1]);
		const unit = match[2]!.toLowerCase();
		const multiplier = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : 60_000;
		total += amount * multiplier;
	}
	return found ? total : undefined;
}

function codexResetOffset(message: string, at: number): { resetAt?: number; uncertaintyMs: number } {
	const relative = message.match(/(?:Resets in[ ]+~?|Try again in[ ]+~?)([0-9.]+[ ]*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m))/i);
	if (!relative) return { uncertaintyMs: EXACT_MS };
	const offset = durationMs(relative[1]!);
	if (offset === undefined) return { uncertaintyMs: EXACT_MS };
	const approximate = relative[0]!.includes("~");
	if (!approximate) return { resetAt: at + offset, uncertaintyMs: EXACT_MS };
	const hours = relative[1]!.match(/^([0-9]+(?:[.][0-9]+)?)[ ]*(?:hours?|hrs?|hr|h)$/i);
	if (hours?.[1]?.includes(".")) return { resetAt: at + offset, uncertaintyMs: 180_000 };
	if (hours) return { resetAt: at + offset, uncertaintyMs: 1_800_000 };
	return { resetAt: at + offset, uncertaintyMs: 30_000 };
}

function classifyCodex({ message, at }: { message: string; at: number }): LimitSignal | null {
	const root = decodeJsonError(message);
	const error = isRecord(root?.error) ? root.error : root;
	const code = String(error?.code ?? "");
	if (/usage_not_included|overloaded|server.*overload|context.?window|maximum context/i.test(message)) return null;
	const isLimit =
		/Codex error: The usage limit has been reached|Codex usage limit reached|hit your ChatGPT usage limit|usage_limit_reached/i.test(message) ||
		code === "usage_limit_reached";
	if (!isLimit) return null;

	const weekly = /weekly[ ]+100%|weekly.{0,40}(?:exhausted|limit reached)|7.day/i.test(message);
	const window = weekly
		? "weekly"
		: message === "Codex error: The usage limit has been reached"
			? "unknown"
			: "5h";
	const parsedReset = codexResetOffset(message, at);
	return makeSignal(window, "Codex usage limit", parsedReset.resetAt, parsedReset.uncertaintyMs);
}

function parseEpoch(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function parseCodexWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent =
		typeof value.used_percent === "number" && Number.isFinite(value.used_percent)
			? value.used_percent
			: undefined;
	const windowMinutes =
		typeof value.window_minutes === "number" && Number.isFinite(value.window_minutes)
			? value.window_minutes
			: typeof value.limit_window_seconds === "number" && Number.isFinite(value.limit_window_seconds)
				? Math.ceil(value.limit_window_seconds / 60)
				: undefined;
	const resetAt = parseEpoch(value.resets_at) ?? parseEpoch(value.reset_at);
	if (usedPercent === undefined && windowMinutes === undefined && resetAt === undefined) return undefined;
	return { usedPercent, windowMinutes, resetAt };
}

function codexWindows(source: unknown, label: string): WindowReport[] {
	if (!isRecord(source)) return [];
	const rateLimit = isRecord(source.rate_limit) ? source.rate_limit : source;
	const primary = parseCodexWindow(rateLimit.primary_window) ?? parseCodexWindow(rateLimit.primary);
	const secondary = parseCodexWindow(rateLimit.secondary_window) ?? parseCodexWindow(rateLimit.secondary);
	const reports: WindowReport[] = [];
	if (primary) reports.push({ label, window: primary });
	if (secondary) reports.push({ label, window: secondary });
	return reports;
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? "usage unavailable" : `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function codexReportText(reports: WindowReport[]): string {
	const fiveHour = reports.filter(({ window }) => window.windowMinutes === 300);
	const weekly = reports.filter(({ window }) => window.windowMinutes === 10_080);
	const summaries: string[] = [];
	for (const [name, windows] of [["5h", fiveHour], ["weekly", weekly]] as const) {
		if (windows.length === 0) continue;
		const usage = windows.map(({ label, window }) => {
			const source = label === "Codex" ? "" : `${label} `;
			const reset = window.resetAt === undefined ? "" : ` (resets ${formatLocalTime(window.resetAt)})`;
			return `${source}${formatPercent(window.usedPercent)}${reset}`;
		});
		summaries.push(`Codex ${name} ${usage.join(" / ")}`);
	}
	if (summaries.length > 0) return summaries.join(", ");
	return `Codex usage windows: ${reports.map(({ window }) => formatPercent(window.usedPercent)).join(", ") || "no populated buckets"}`;
}

function parseCodexUsage(payload: unknown): LimitSignal | null {
	if (!isRecord(payload)) return null;
	const reports = codexWindows(payload.rate_limit, "Codex");
	if (Array.isArray(payload.additional_rate_limits)) {
		for (const item of payload.additional_rate_limits) {
			if (isRecord(item)) reports.push(...codexWindows(item, "additional"));
		}
	}
	if (!isRecord(payload.rate_limit) && reports.length === 0) return null;

	const weekly = reports.filter(({ window }) => window.windowMinutes === 10_080 && window.usedPercent !== undefined && window.usedPercent >= 100);
	if (weekly.length > 0) {
		const resetAt = maxReset(weekly);
		return makeSignal("weekly", codexReportText(reports), resetAt);
	}
	const exhaustedFiveHour = reports.filter(({ window }) => window.windowMinutes === 300 && window.usedPercent !== undefined && window.usedPercent >= 100);
	if (exhaustedFiveHour.length > 0) {
		if (exhaustedFiveHour.some(({ window }) => window.resetAt === undefined)) {
			return makeSignal("unknown", codexReportText(reports));
		}
		return makeSignal("5h", codexReportText(reports), maxReset(exhaustedFiveHour));
	}
	return makeSignal("unknown", codexReportText(reports));
}

function maxReset(reports: WindowReport[]): number | undefined {
	const resets = reports.flatMap(({ window }) => window.resetAt === undefined ? [] : [window.resetAt]);
	return resets.length === 0 ? undefined : Math.max(...resets);
}

function codexAccountId(token: string): string | undefined {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) return undefined;
		const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
		const payload: unknown = JSON.parse(atob(base64));
		const auth = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
		return isRecord(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function resolveBaseUrl(baseUrl: string, fallback: string): URL | undefined {
	try {
		const parsed = new URL(baseUrl || fallback);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

async function getJson(request: ProbeRequest, url: URL, headers: Headers): Promise<unknown> {
	try {
		// redirect:"error" keeps the token and account header on the configured provider origin only.
		const response = await request.fetch(url.href, { method: "GET", headers, signal: request.signal, redirect: "error" });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	}
}

async function probeCodex(request: ProbeRequest): Promise<LimitSignal | null> {
	const accountId = codexAccountId(request.token);
	const base = resolveBaseUrl(request.baseUrl, CODEX_DEFAULT_BASE);
	if (!accountId || !base) return null;
	const path = base.pathname.replace(/\/+$/, "");
	base.pathname = `${path}/`;
	const url = new URL("wham/usage", base);
	const payload = await getJson(request, url, new Headers({
		authorization: `Bearer ${request.token}`,
		"chatgpt-account-id": accountId,
		accept: "application/json",
		"OAI-Language": "en",
		originator: "pi",
	}));
	return parseCodexUsage(payload);
}

function anthropicUsageWindow(value: unknown, now: number): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = typeof value.utilization === "number" && Number.isFinite(value.utilization) ? value.utilization : undefined;
	const resetAt = parseEpoch(value.resets_at);
	if (usedPercent === undefined && resetAt === undefined) return undefined;
	return { usedPercent, resetAt: resetAt !== undefined && resetAt >= now ? resetAt : undefined };
}

function parseAnthropicUsage(payload: unknown, now: number): LimitSignal | null {
	if (!isRecord(payload)) return null;
	const windows = Object.entries(payload)
		.filter(([name]) => name === "five_hour" || name.startsWith("seven_day"))
		.map(([name, value]) => ({ name, window: anthropicUsageWindow(value, now) }))
		.filter((item): item is { name: string; window: UsageWindow } => item.window !== undefined);
	if (windows.length === 0) return null;
	const weekly = windows.filter(({ name, window }) => name.startsWith("seven_day") && window.usedPercent !== undefined && window.usedPercent >= 100);
	if (weekly.length > 0) return makeSignal("weekly", formatAnthropicUsage(windows), maxAnthropicReset(weekly));
	const fiveHour = windows.find(({ name, window }) => name === "five_hour" && window.usedPercent !== undefined && window.usedPercent >= 100);
	if (fiveHour) return makeSignal("5h", formatAnthropicUsage(windows), fiveHour.window.resetAt);
	return makeSignal("unknown", formatAnthropicUsage(windows));
}

function formatAnthropicUsage(windows: { name: string; window: UsageWindow }[]): string {
	return windows.map(({ name, window }) => {
		const reset = window.resetAt === undefined ? "" : ` (resets ${formatLocalTime(window.resetAt)})`;
		return `Anthropic ${name} ${formatPercent(window.usedPercent)}${reset}`;
	}).join(", ");
}

function maxAnthropicReset(windows: { window: UsageWindow }[]): number | undefined {
	const resets = windows.flatMap(({ window }) => window.resetAt === undefined ? [] : [window.resetAt]);
	return resets.length === 0 ? undefined : Math.max(...resets);
}

// Community-observed undocumented OAuth endpoint and response: https://github.com/FullFran/claudeops-tui/blob/main/docs/oauth-usage-endpoint.md
function classifyAnthropic({ message }: { message: string; at: number }): LimitSignal | null {
	const root = decodeJsonError(message);
	const error = isRecord(root?.error) ? root.error : undefined;
	if (!/429/.test(message) || error?.type !== "rate_limit_error") return null;
	if (!/account's rate limit|account rate limit/i.test(String(error.message ?? ""))) return null;
	return makeSignal("unknown", "Anthropic account rate limit");
}

async function probeAnthropic(request: ProbeRequest): Promise<LimitSignal | null> {
	if (request.isOAuth === false || (request.isOAuth === undefined && !request.token.startsWith(OAUTH_TOKEN_PREFIX))) return null;
	const base = resolveBaseUrl(request.baseUrl, ANTHROPIC_DEFAULT_BASE);
	if (!base) return null;
	const url = new URL("/api/oauth/usage", base.origin);
	const payload = await getJson(request, url, new Headers({
		authorization: `Bearer ${request.token}`,
		"anthropic-beta": "oauth-2025-04-20",
		"user-agent": "pi-limit-resume/0.1",
		accept: "application/json",
	}));
	return parseAnthropicUsage(payload, request.now);
}

function parseZaiReset(message: string, at: number, window: LimitSignal["window"]): number | undefined {
	const raw = message.match(/(?:Your limit will reset at|Resets at|限额将在)[ ]*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i)?.[1];
	if (!raw) return undefined;
	const timestamp = raw.includes("T") ? raw : raw.replace(" ", "T");
	const explicitZone = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(timestamp);
	if (explicitZone) {
		const exact = Date.parse(timestamp);
		return Number.isFinite(exact) ? exact : undefined;
	}
	if (window === "weekly") return Date.parse(`${timestamp}+08:00`);

	const candidates = [Date.parse(`${timestamp}+08:00`), Date.parse(`${timestamp}Z`)];
	const valid = candidates.filter((candidate) =>
		Number.isFinite(candidate) && candidate >= at - 120_000 && candidate <= at + MAX_WAIT_MS,
	);
	return valid.length === 1 ? valid[0] : undefined;
}

function classifyZai({ message, at }: { message: string; at: number }): LimitSignal | null {
	const root = decodeJsonError(message);
	const error = isRecord(root?.error) ? root.error : root;
	const code = String(error?.code ?? "");
	const detail = String(error?.message ?? message);
	if (code === "1310" || /weekly\/monthly limit exhausted|每周\/每月使用上限|已达到 7 天使用上限/i.test(detail)) {
		return {
			...makeSignal("weekly", "GLM weekly/monthly quota exhausted", parseZaiReset(detail, at, "weekly")),
			resetTimeZone: "Asia/Shanghai",
		};
	}
	if (code !== "1308" && !/usage limit reached for|使用上限|5-hour usage limit/i.test(detail)) return null;
	const fiveHour = code === "1308" || /5.hour|过去 5 小时|5 小时/i.test(detail);
	const window = fiveHour ? "5h" : "unknown";
	return makeSignal(window, "GLM Coding Plan usage limit", parseZaiReset(detail, at, window));
}

function classifyOpenCodeGo({ message, at }: { message: string; at: number }): LimitSignal | null {
	if (!/GoUsageLimitError/i.test(message)) return null;
	const relative = message.match(/Resets in[ ]+([^.!\n]+)/i)?.[1];
	const offset = relative === undefined ? undefined : durationMs(relative);
	if (/weekly|7.day|monthly/i.test(message)) return makeSignal("weekly", "OpenCode Go longer-window quota");
	return makeSignal("5h", "OpenCode Go five-hour usage limit", offset === undefined ? undefined : at + offset, 60_000);
}

export const ADAPTERS: readonly LimitAdapter[] = [
	{
		id: "codex",
		providers: ["openai-codex"],
		defaultBaseUrl: CODEX_DEFAULT_BASE,
		classify: classifyCodex,
		probe: probeCodex,
	},
	{
		id: "anthropic",
		providers: ["anthropic"],
		defaultBaseUrl: ANTHROPIC_DEFAULT_BASE,
		oauthOnlyProbe: true,
		classify: classifyAnthropic,
		probe: probeAnthropic,
	},
	{ id: "zai", providers: ["zai", "zai-coding-cn"], classify: classifyZai },
	{ id: "opencode-go", providers: ["opencode-go"], classify: classifyOpenCodeGo },
];

export function adapterFor(provider: string): LimitAdapter | undefined {
	return ADAPTERS.find((adapter) => adapter.providers.includes(provider));
}
