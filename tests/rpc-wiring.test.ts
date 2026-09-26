import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface RpcRecord {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	method?: string;
	message?: unknown;
	role?: string;
	content?: unknown;
	stopReason?: string;
	[key: string]: unknown;
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.flatMap((part) => {
		if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") return [part.text];
		return [];
	}).join(" ");
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(payload));
}

function sendAnthropicSuccess(response: ServerResponse, id: string): void {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const events = [
		["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "limit-resume-e2e", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "E2E OK" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	] as const;
	for (const [name, payload] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
	response.end();
}

function fakeJwt(): string {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "e2e-fixture-account" } };
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

async function startMockProvider() {
	let modelCalls = 0;
	let usageCalls = 0;
	let limitReturned = false;
	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/wham/usage") {
			usageCalls++;
			sendJson(response, 200, {
				rate_limit: {
					primary_window: {
						used_percent: 100,
						window_minutes: 300,
						resets_at: Math.ceil(Date.now() / 1000) + 5,
					},
				},
			});
			return;
		}
		if (request.method !== "POST") {
			sendJson(response, 404, { error: "not found" });
			return;
		}

		modelCalls++;
		let body: any;
		try {
			body = JSON.parse(await readBody(request));
		} catch {
			sendJson(response, 400, { error: "invalid fixture request" });
			return;
		}
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const lastUser = [...messages].reverse().find((message: any) => message?.role === "user");
		const prompt = messageText(lastUser?.content);
		if (prompt.includes("trigger-limit-resume") && !limitReturned) {
			limitReturned = true;
			sendJson(response, 429, {
				type: "error",
				error: {
					type: "rate_limit_error",
					code: "usage_limit_reached",
					message: "Codex error: The usage limit has been reached",
				},
			});
			return;
		}
		sendAnthropicSuccess(response, `msg-e2e-${modelCalls}`);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("mock provider did not bind a TCP port");
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
		counts: () => ({ modelCalls, usageCalls }),
	};
}

function watchRecords(child: ChildProcessWithoutNullStreams, secret: string) {
	const records: RpcRecord[] = [];
	let stdoutBuffer = "";
	let stderr = "";
	const watchers = new Set<{
		predicate: (record: RpcRecord) => boolean;
		resolve: (value: { record: RpcRecord; index: number }) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		let newline = stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			newline = stdoutBuffer.indexOf("\n");
			if (!line) continue;
			let record: RpcRecord;
			try {
				record = JSON.parse(line) as RpcRecord;
			} catch {
				continue;
			}
			const index = records.push(record) - 1;
			for (const watcher of [...watchers]) {
				if (!watcher.predicate(record)) continue;
				clearTimeout(watcher.timer);
				watchers.delete(watcher);
				watcher.resolve({ record, index });
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-16_000);
	});

	return {
		records,
		get stderr() { return stderr.replaceAll(secret, "[redacted]"); },
		waitFor(predicate: (record: RpcRecord) => boolean, timeoutMs = 20_000) {
			const existing = records.findIndex(predicate);
			if (existing >= 0) return Promise.resolve({ record: records[existing]!, index: existing });
			return new Promise<{ record: RpcRecord; index: number }>((resolve, reject) => {
				const watcher = {
					predicate,
					resolve,
					reject,
					timer: setTimeout(() => {
						watchers.delete(watcher);
									const recent = records.slice(-40).map((record) => {
							const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : undefined;
							const details = [record.id, record.command, record.method, typeof record.message === "string" ? record.message.slice(0, 120) : undefined, message?.role, message?.provider, message?.stopReason, typeof message?.errorMessage === "string" ? message.errorMessage.slice(0, 160).replaceAll(secret, "[redacted]") : undefined].filter(Boolean).join(" ");
							return `${record.type ?? "?"}${details ? `: ${details}` : ""}`;
						}).join("\n");
						reject(new Error(`Timed out waiting for RPC event. Records:\n${recent}\nstderr: ${this.stderr}`));
					}, timeoutMs),
				};
				watchers.add(watcher);
			});
		},
		async waitForAfter(after: number, predicate: (record: RpcRecord) => boolean, timeoutMs = 20_000) {
			const existing = records.findIndex((record, index) => index > after && predicate(record));
			if (existing >= 0) return { record: records[existing]!, index: existing };
			return await this.waitFor((record) => {
				const index = records.indexOf(record);
				return index > after && predicate(record);
			}, timeoutMs);
		},
	};
}

async function request(child: ChildProcessWithoutNullStreams, id: string, payload: Record<string, unknown>): Promise<void> {
	child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
}

async function stopChild(child: ChildProcessWithoutNullStreams, closed: Promise<unknown>): Promise<void> {
	child.stdin.end();
	const stopped = await Promise.race([closed.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))]);
	if (!stopped) {
		child.kill("SIGKILL");
		await closed;
	}
}


// Scope: proves the real Pi RPC lifecycle wiring (agent_settled -> classify -> usage probe -> timer -> sendUserMessage)
// against a loopback mock that speaks anthropic-messages under the provider id "openai-codex". It is NOT evidence
// for the real Codex SSE/WebSocket transport, real limit payloads, or coexistence with pi-codex-conversion.
// Requires the `pi` CLI on PATH; skipped otherwise.
const hasPi = spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasPi)("limit-resume RPC wiring (mock transport)", () => {
	it("wiring only: mock anthropic-messages transport under the openai-codex id probes once and resumes once", async () => {
		const startedAt = Date.now();
		const tempRoot = await mkdtemp(join(tmpdir(), "pi-limit-resume-e2e-"));
		const agentDir = join(tempRoot, "agent");
		const workDir = join(tempRoot, "work");
		await Promise.all([mkdir(join(agentDir, "extensions"), { recursive: true }), mkdir(workDir)]);
		const extensionSource = join(process.cwd(), "extensions", "limit-resume");
		await symlink(extensionSource, join(agentDir, "extensions", "limit-resume"), "dir");

		const provider = await startMockProvider();
		const token = fakeJwt();
		const settings = { retry: { enabled: false } };
		const models = {
			providers: {
				"openai-codex": {
					baseUrl: provider.baseUrl,
					api: "anthropic-messages",
					apiKey: token,
					models: [{
						id: "limit-resume-e2e",
						name: "Limit Resume E2E",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 1024,
					}],
				},
			},
		};
		await Promise.all([
			writeFile(join(agentDir, "settings.json"), JSON.stringify(settings)),
			writeFile(join(agentDir, "models.json"), JSON.stringify(models)),
		]);

		const child = spawn("pi", ["--mode", "rpc", "--no-session", "--model", "openai-codex/limit-resume-e2e"], {
			cwd: workDir,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_LIMIT_RESUME_GRACE_MS: "0",
				OPENAI_API_KEY: "",
				OPENAI_CODEX_API_KEY: "",
			},
		});
		const closed = once(child, "close");
		const rpc = watchRecords(child, token);

		try {
			await request(child, "ready", { type: "get_state" });
			const ready = await rpc.waitFor((record) => record.type === "response" && record.id === "ready");
			expect(ready.record.success).toBe(true);
			await request(child, "commands", { type: "get_commands" });
			const commandList = await rpc.waitFor((record) => record.type === "response" && record.id === "commands");
			const commands = (commandList.record.data as { commands?: { name: string }[] } | undefined)?.commands ?? [];
			expect(commands.some((command) => command.name === "limit-resume")).toBe(true);

			const firstStart = rpc.records.length - 1;
			await request(child, "first", { type: "prompt", message: "first prompt; reply with the fixture response" });
			await rpc.waitFor((record) => record.type === "response" && record.id === "first" && record.success === true);
			const firstSuccess = await rpc.waitForAfter(firstStart, (record) =>
				record.type === "message_end" && record.message &&
					(record.message as { role?: string; stopReason?: string; content?: unknown }).role === "assistant" &&
					(record.message as { stopReason?: string }).stopReason !== "error" &&
					messageText((record.message as { content?: unknown }).content).includes("E2E OK"),
			);
			const firstSettled = await rpc.waitForAfter(firstSuccess.index, (record) => record.type === "agent_settled");

			const secondStart = firstSettled.index;
			await request(child, "limited", { type: "prompt", message: "trigger-limit-resume; reply with the fixture response" });
			await rpc.waitFor((record) => record.type === "response" && record.id === "limited" && record.success === true);
			const waitNotice = await rpc.waitForAfter(secondStart, (record) =>
				record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string" && record.message.includes("Usage limit detected"),
			);
			const continuation = await rpc.waitForAfter(waitNotice.index, (record) =>
				record.type === "message_start" && record.message &&
					(record.message as { role?: string }).role === "user" && messageText((record.message as { content?: unknown }).content).trim() === "continue",
			);
			const success = await rpc.waitForAfter(continuation.index, (record) =>
				record.type === "message_end" && record.message &&
					(record.message as { role?: string; stopReason?: string; content?: unknown }).role === "assistant" &&
					(record.message as { stopReason?: string }).stopReason !== "error" &&
					messageText((record.message as { content?: unknown }).content).includes("E2E OK"),
			);
			await rpc.waitForAfter(success.index, (record) => record.type === "agent_settled");

			expect(waitNotice.index).toBeLessThan(continuation.index);
			expect(continuation.index).toBeLessThan(success.index);
			expect(provider.counts()).toEqual({ modelCalls: 3, usageCalls: 1 });
			expect(Date.now() - startedAt).toBeLessThan(60_000);
			expect(JSON.stringify(rpc.records)).not.toContain(token);
			expect(rpc.stderr).not.toContain(token);
		} finally {
			await stopChild(child, closed);
			await new Promise<void>((resolve) => provider.server.close(() => resolve()));
			await rm(tempRoot, { recursive: true, force: true });
		}
	}, 60_000);
});
