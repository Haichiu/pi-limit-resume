import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { adapterFor } from "./adapters.js";
import {
	checkResume,
	decide,
	formatLocalTime,
	formatRelative,
	GRACE_MS,
	INITIAL_RESUME_STATE,
	PROBE_TIMEOUT_MS,
	RESUME_TEXT,
	TICK_MS,
	transition,
	type LimitAdapter,
	type LimitSignal,
	type LiveSnapshot,
	type ResumeState,
	type WaitTarget,
} from "./core.js";

interface AssistantLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

interface MessageEntry {
	id: string | undefined;
	message: AssistantLike;
}

type WaitingState = Extract<ResumeState, { kind: "waiting" }>;

/** A usage probe still running for a detected limit. It must be cancellable before any wait exists. */
interface PendingDetection {
	provider: string;
	model: string;
	abort: AbortController;
}

/** Latest message entry on the active branch; non-message entries (custom entries etc.) are skipped. */
function latestMessageEntry(ctx: ExtensionContext): MessageEntry | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const id = (entry as { id?: unknown }).id;
		return { id: typeof id === "string" ? id : undefined, message: entry.message as AssistantLike };
	}
	return undefined;
}

function isSuccessfulAssistant(message: AssistantLike): boolean {
	return message.role === "assistant" &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "pending";
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function describeModel(provider: string | undefined, model: string | undefined): string {
	return `${provider ?? "none"}/${model ?? "none"}`;
}

function formatSignal(signal: LimitSignal): string {
	const reset = signal.resetAt === undefined
		? "reset unknown"
		: `resets ${formatLocalTime(signal.resetAt, signal.resetTimeZone)}`;
	return `${signal.window}; ${reset}; ${signal.evidence}`;
}

function formatWait(wait: WaitingState, now: number): string {
	const reset = wait.signal.resetAt === undefined
		? "reset time unknown"
		: `reset ${formatLocalTime(wait.signal.resetAt, wait.signal.resetTimeZone)}`;
	return `waiting for ${describeModel(wait.target.provider, wait.target.model)} until ${formatLocalTime(wait.resumeAt)} (${reset}, about ${formatRelative(wait.resumeAt - now)}); ${wait.signal.evidence}`;
}

/**
 * Runs the adapter's read-only usage probe with a hard timeout. `cancel` aborts both the HTTP request
 * and the wait for it, so a cancelled detection can never resolve into an armed timer.
 */
async function runProbe(
	adapter: LimitAdapter,
	provider: string,
	ctx: ExtensionContext,
	cancel: AbortSignal,
): Promise<LimitSignal | null> {
	if (!adapter.probe) return null;
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(provider);
		const model = ctx.model?.provider === provider ? ctx.model : undefined;
		const token = auth?.auth.apiKey ?? await ctx.modelRegistry.getApiKeyForProvider(provider);
		const baseUrl = auth?.auth.baseUrl ?? model?.baseUrl ?? adapter.defaultBaseUrl;
		if (!token || !baseUrl || cancel.aborted) return null;
		const isOAuth = adapter.oauthOnlyProbe && model
			? ctx.modelRegistry.isUsingOAuth(model)
			: undefined;

		const controller = new AbortController();
		const abort = (): void => controller.abort();
		cancel.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, PROBE_TIMEOUT_MS);
		timer.unref?.();
		const aborted = new Promise<null>((resolve) => {
			controller.signal.addEventListener("abort", () => resolve(null), { once: true });
		});
		try {
			const probe = adapter.probe({
				token,
				baseUrl,
				fetch,
				signal: controller.signal,
				now: Date.now(),
				...(isOAuth === undefined ? {} : { isOAuth }),
			});
			return await Promise.race([probe, aborted]);
		} finally {
			clearTimeout(timer);
			cancel.removeEventListener("abort", abort);
		}
	} catch {
		return null;
	}
}

export default function limitResume(pi: ExtensionAPI): void {
	let state: ResumeState = INITIAL_RESUME_STATE;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: PendingDetection | undefined;
	let ourAgentStartPending = false;
	let lastDecision = "idle";
	let stopped = false;

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus("limit-resume", undefined);
	}

	function clearTimer(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	/** Cancels a running usage probe and/or an armed wait. Returns true when something was cancelled. */
	function stopAll(ctx: ExtensionContext, notice?: string): boolean {
		const hadDetection = pending !== undefined;
		if (pending) {
			pending.abort.abort();
			pending = undefined;
		}
		const hadWait = state.kind === "waiting";
		if (hadWait) {
			clearTimer();
			state = transition(state, { type: "cancel" });
			clearStatus(ctx);
		}
		if (!hadDetection && !hadWait) return false;
		lastDecision = "cancelled";
		if (notice) notify(ctx, notice, "info");
		return true;
	}

	function finishWait(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
		clearTimer();
		state = transition(state, { type: "final" });
		clearStatus(ctx);
		lastDecision = message;
		notify(ctx, message, type);
	}

	function liveSnapshot(ctx: ExtensionContext): LiveSnapshot {
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			latestEntryId: latestMessageEntry(ctx)?.id,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			idle: ctx.isIdle(),
			pendingMessages: ctx.hasPendingMessages(),
		};
	}

	function fire(wait: WaitingState, ctx: ExtensionContext): void {
		const blocked = checkResume(wait.target, liveSnapshot(ctx));
		if (blocked) {
			finishWait(ctx, `Usage limit wait ended: ${blocked}, not resumed.`, "warning");
			return;
		}
		state = transition(state, { type: "auto-resumed" });
		clearStatus(ctx);
		lastDecision = "continuing after usage reset";
		ourAgentStartPending = true;
		try {
			pi.sendUserMessage(RESUME_TEXT);
			notify(ctx, "Usage limit wait ended; sent continue.", "info");
		} catch {
			ourAgentStartPending = false;
			state = transition(state, { type: "final" });
			lastDecision = "could not send continuation";
			notify(ctx, "Usage limit wait ended, but continue could not be sent.", "error");
		}
	}

	function scheduleCheck(wait: WaitingState, ctx: ExtensionContext): void {
		if (stopped || state !== wait) return;
		try {
			const remaining = wait.resumeAt - Date.now();
			if (remaining > 0) {
				if (ctx.hasUI) ctx.ui.setStatus("limit-resume", `resume in ${formatRelative(remaining)}`);
				timer = setTimeout(() => {
					timer = undefined;
					scheduleCheck(wait, ctx);
				}, Math.min(TICK_MS, remaining));
				timer.unref?.();
				return;
			}
			fire(wait, ctx);
		} catch (error) {
			// A captured context throws once Pi disposes this runtime (reload or session replacement).
			stopped = true;
			clearTimer();
			state = INITIAL_RESUME_STATE;
			console.warn(`[limit-resume] stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function startWait(ctx: ExtensionContext, target: WaitTarget, signal: LimitSignal, resumeAt: number): void {
		const next = transition(state, { type: "wait", target, signal, resumeAt });
		if (next.kind !== "waiting") return;
		state = next;
		lastDecision = `waiting for ${describeModel(target.provider, target.model)}`;
		const reset = signal.resetAt === undefined ? "unknown" : formatLocalTime(signal.resetAt, signal.resetTimeZone);
		notify(
			ctx,
			`Usage limit detected (${signal.evidence}); reset ${reset}. Waiting until ${formatLocalTime(resumeAt)} (about ${formatRelative(resumeAt - Date.now())}). Use /limit-resume cancel to cancel.`,
			"info",
		);
		scheduleCheck(next, ctx);
	}

	async function handleSettled(ctx: ExtensionContext): Promise<void> {
		if (stopped || !ctx.hasUI) return;
		const latest = latestMessageEntry(ctx);
		if (!latest || latest.message.role !== "assistant") return;
		const message = latest.message;
		if (isSuccessfulAssistant(message)) {
			if (state.resumedAwaitingProgress) {
				state = transition(state, { type: "success" });
				lastDecision = "continuation succeeded";
			}
			return;
		}
		if (message.stopReason !== "error" || state.kind === "waiting" || pending) return;

		const text = stringField(message.errorMessage);
		const provider = stringField(message.provider);
		const model = stringField(message.model);
		if (!text || !provider || !model || !latest.id) return;
		const adapter = adapterFor(provider);
		if (!adapter) return;
		const classified = adapter.classify({ message: text, at: Date.now() });
		if (!classified) return;

		if (state.resumedAwaitingProgress) {
			finishWait(ctx, "Still limited after auto-continue; not retrying again.", "error");
			return;
		}
		// Never continue on a model other than the one that hit the limit (e.g. after an automatic reserve switch).
		if (ctx.model?.provider !== provider || ctx.model?.id !== model) {
			finishWait(
				ctx,
				`Usage limit on ${describeModel(provider, model)}, but the current model is ${describeModel(ctx.model?.provider, ctx.model?.id)}; not auto-continuing.`,
				"warning",
			);
			return;
		}
		const target: WaitTarget = { provider, model, sessionId: ctx.sessionManager.getSessionId(), entryId: latest.id };

		let signal = classified;
		if (adapter.probe && (signal.resetAt === undefined || signal.window === "unknown")) {
			const detection: PendingDetection = { provider, model, abort: new AbortController() };
			pending = detection;
			let probed: LimitSignal | null;
			try {
				probed = await runProbe(adapter, provider, ctx, detection.abort.signal);
			} finally {
				if (pending === detection) pending = undefined;
			}
			// Cancelled (command, input, model/branch change, another run, shutdown) while probing: never arm.
			if (detection.abort.signal.aborted || stopped) return;
			if (probed) signal = probed;
		}

		const decision = decide(signal, Date.now(), GRACE_MS);
		if (decision.kind === "final") {
			finishWait(ctx, `${decision.reason}; ${signal.evidence}.`, "warning");
			return;
		}
		startWait(ctx, target, signal, decision.resumeAt);
	}

	function statusText(): string {
		const current = state.kind === "waiting"
			? formatWait(state, Date.now())
			: pending
				? `checking usage for ${describeModel(pending.provider, pending.model)}`
				: "idle";
		return `${current}; last decision: ${lastDecision}`;
	}

	async function commandProbe(ctx: ExtensionCommandContext): Promise<void> {
		const model = ctx.model;
		const adapter = model ? adapterFor(model.provider) : undefined;
		if (!model || !adapter?.probe) {
			notify(ctx, "The current model has no limit-resume usage probe.", "warning");
			return;
		}
		const signal = await runProbe(adapter, model.provider, ctx, new AbortController().signal);
		if (!signal) {
			notify(ctx, "Probe unavailable: no readable usage data or supported auth was found.", "warning");
			return;
		}
		notify(ctx, `Probe: ${formatSignal(signal)}.`, "info");
	}

	pi.registerCommand("limit-resume", {
		description: "Show or cancel automatic usage-limit resume; probe current provider usage",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "" || command === "status") {
				notify(ctx, statusText(), "info");
				return;
			}
			if (command === "cancel") {
				if (!stopAll(ctx, "Limit resume cancelled.")) notify(ctx, "No limit-resume wait is pending.", "info");
				return;
			}
			if (command === "probe") {
				await commandProbe(ctx);
				return;
			}
			notify(ctx, "Usage: /limit-resume [status|cancel|probe]", "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		stopAll(ctx);
		state = INITIAL_RESUME_STATE;
		stopped = false;
		ourAgentStartPending = false;
		lastDecision = "idle";
	});

	pi.on("agent_settled", (_event, ctx) => handleSettled(ctx));

	pi.on("message_end", (event) => {
		if (isSuccessfulAssistant(event.message as AssistantLike) && state.resumedAwaitingProgress) {
			state = transition(state, { type: "success" });
			lastDecision = "continuation succeeded";
		}
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		// Extension slash commands (including /limit-resume) are dispatched before input handlers run
		// (AgentSession.prompt -> _tryExecuteExtensionCommand), so they never reach this hook.
		stopAll(ctx, "Limit resume cancelled by new user input.");
	});

	pi.on("model_select", (event, ctx) => {
		const target = state.kind === "waiting" ? state.target : pending;
		if (!target) return;
		const next = event.model as { provider?: string; id?: string } | undefined;
		if (next?.provider === target.provider && next?.id === target.model) return;
		stopAll(ctx, `Limit resume cancelled: model changed to ${describeModel(next?.provider, next?.id)}.`);
	});

	// /tree navigation stays in the same session runtime (no session_shutdown), so it must cancel explicitly.
	pi.on("session_tree", (event, ctx) => {
		if (event.newLeafId !== null && event.newLeafId === event.oldLeafId) return;
		stopAll(ctx, "Limit resume cancelled: conversation branch changed.");
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ourAgentStartPending) {
			ourAgentStartPending = false;
			return;
		}
		stopAll(ctx, "Limit resume cancelled because another agent run started.");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopped = true;
		stopAll(ctx);
		state = INITIAL_RESUME_STATE;
		ourAgentStartPending = false;
	});
}
