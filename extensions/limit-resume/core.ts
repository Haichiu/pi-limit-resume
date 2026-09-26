export type LimitWindow = "5h" | "weekly" | "unknown";

export interface LimitSignal {
	window: LimitWindow;
	resetAt?: number;
	resetTimeZone?: string;
	uncertaintyMs: number;
	evidence: string;
}

export interface ProbeRequest {
	token: string;
	baseUrl: string;
	fetch: typeof fetch;
	signal: AbortSignal;
	now: number;
	isOAuth?: boolean;
}

export interface LimitAdapter {
	id: string;
	providers: readonly string[];
	defaultBaseUrl?: string;
	oauthOnlyProbe?: boolean;
	classify(error: { message: string; at: number }): LimitSignal | null;
	probe?(request: ProbeRequest): Promise<LimitSignal | null>;
}

export type Decision = { kind: "wait"; resumeAt: number } | { kind: "final"; reason: string };

/** Where the limit happened; a continuation is only valid at exactly this conversation position. */
export interface WaitTarget {
	provider: string;
	model: string;
	sessionId: string;
	/** Session entry id of the assistant limit-error message. */
	entryId: string;
}

/** Live facts read from the runtime immediately before sending a continuation. */
export interface LiveSnapshot {
	sessionId: string | undefined;
	latestEntryId: string | undefined;
	provider: string | undefined;
	model: string | undefined;
	idle: boolean;
	pendingMessages: boolean;
}

export type ResumeState =
	| { kind: "idle"; resumedAwaitingProgress: boolean }
	| { kind: "waiting"; target: WaitTarget; signal: LimitSignal; resumeAt: number; resumedAwaitingProgress: false };

export type ResumeEvent =
	| { type: "wait"; target: WaitTarget; signal: LimitSignal; resumeAt: number }
	| { type: "auto-resumed" }
	| { type: "cancel" | "success" | "final" };

export const INITIAL_RESUME_STATE: ResumeState = { kind: "idle", resumedAwaitingProgress: false };

export function transition(state: ResumeState, event: ResumeEvent): ResumeState {
	switch (event.type) {
		case "wait":
			if (state.kind === "waiting") return state;
			return {
				kind: "waiting",
				target: event.target,
				signal: event.signal,
				resumeAt: event.resumeAt,
				resumedAwaitingProgress: false,
			};
		case "auto-resumed":
			if (state.kind !== "waiting") return state;
			return { kind: "idle", resumedAwaitingProgress: true };
		case "cancel":
			if (state.kind !== "waiting") return state;
			return INITIAL_RESUME_STATE;
		case "success":
			if (!state.resumedAwaitingProgress) return state;
			return INITIAL_RESUME_STATE;
		case "final":
			return INITIAL_RESUME_STATE;
	}
}

const MINUTE_MS = 60_000;
export const RESUME_TEXT = "continue";
export const GRACE_MS = parseGrace(process.env.PI_LIMIT_RESUME_GRACE_MS);
export const MAX_WAIT_MS = 5 * 60 * 60 * 1000 + 15 * MINUTE_MS;
export const TICK_MS = 15_000;
export const PROBE_TIMEOUT_MS = 10_000;

export function parseGrace(value?: string): number {
	if (value === undefined || value.length === 0 || [...value].some((character) => character < "0" || character > "9")) return MINUTE_MS;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : MINUTE_MS;
}

export function decide(signal: LimitSignal, now: number, graceMs = GRACE_MS): Decision {
	if (signal.window === "weekly") {
		const reset = signal.resetAt === undefined ? "" : `; resets ${formatLocalTime(signal.resetAt, signal.resetTimeZone, now)}`;
		return { kind: "final", reason: `weekly limit, not auto-continuing${reset}` };
	}
	if (signal.resetAt === undefined || !Number.isFinite(signal.resetAt)) {
		return { kind: "final", reason: "usage limit, reset time unknown" };
	}
	const resumeAt = Math.max(signal.resetAt, now) + Math.max(0, signal.uncertaintyMs) + Math.max(0, graceMs);
	if (resumeAt - now > MAX_WAIT_MS) return { kind: "final", reason: "reset too far" };
	return { kind: "wait", resumeAt };
}

/**
 * Returns why a continuation must NOT be sent now, or undefined when it is safe.
 * Order matters: identity checks (session, position, model) before transient busy state.
 */
export function checkResume(target: WaitTarget, live: LiveSnapshot): string | undefined {
	if (live.sessionId !== target.sessionId) return "session changed";
	if (live.latestEntryId !== target.entryId) return "conversation moved since the limit (new message or branch change)";
	if (live.provider !== target.provider || live.model !== target.model) {
		return `model changed from ${target.provider}/${target.model} to ${live.provider ?? "none"}/${live.model ?? "none"}`;
	}
	if (!live.idle || live.pendingMessages) return "session busy";
	return undefined;
}

export function formatLocalTime(epochMs: number, timeZone?: string, now = Date.now()): string {
	const localDate = new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		...(timeZone ? { timeZone } : {}),
	});
	const sameDay = localDate.format(epochMs) === localDate.format(now);
	return new Intl.DateTimeFormat(undefined, {
		...(!sameDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
		hour: "numeric",
		minute: "2-digit",
		...(timeZone ? { timeZone } : {}),
	}).format(epochMs);
}

export function formatRelative(ms: number): string {
	const minutes = Math.max(0, Math.ceil(ms / MINUTE_MS));
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

