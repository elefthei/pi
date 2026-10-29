import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } from "../src/cli/auth-check.ts";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const tempDir = join(tmpdir(), `pi-test-auth-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function createRuntime(credentials: AuthStorage | ReadOnlyAuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

describe("auth check command", () => {
	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("reports a configured provider as ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
	});

	test("resolves the provider from --model", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--model", "openai/gpt-5.5"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai", "--model", "gpt-5.5"]), runtime),
		).resolves.toMatchObject({ status: "ready", provider: "openai" });
	});

	test("reads credentials without refreshing OAuth when requested", async () => {
		const apiCredentials = AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } });
		const apiRuntime = await createRuntime(apiCredentials);
		await expect(getProviderCredential("openai", apiRuntime, apiCredentials, { refresh: false })).resolves.toBe(
			"test-key",
		);

		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const oauthRuntime = await createRuntime(credentials);
		const oauth = oauthRuntime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(oauth.refresh);
		oauth.refresh = refresh;

		await expect(getProviderCredential("openai-codex", oauthRuntime, credentials, { refresh: false })).resolves.toBe(
			"old-token",
		);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("refreshes OAuth by default", async () => {
		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const runtime = await createRuntime(credentials);
		const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "fresh-token",
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		}));
		oauth.refresh = refresh;

		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai-codex"]), runtime, { refresh: true }),
		).resolves.toMatchObject({
			status: "ready",
		});
		expect(refresh).toHaveBeenCalledOnce();
	});

	test("reports an unknown provider as not ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(checkProviderAuth(parseArgs(["--provider", "not-installed"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "not-installed",
			reason: "provider_not_found",
		});
	});

	test("does not treat an unresolved stored environment reference as configured", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "$MISSING_AUTH_CHECK_KEY" } }), "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
	});

	test("reports malformed auth state as invalid", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, "{invalid-json", "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "invalid",
			provider: "openai",
			reason: "invalid_state",
		});
	});

	test("does not create an auth file or its parent directory", async () => {
		const authPath = join(tempDir, "agent", "auth.json");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toMatchObject({
			status: "not_ready",
			reason: "credentials_not_configured",
		});
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	test("accepts optional JSON output, credential output, and --no-refresh", () => {
		expect(parseAuthCommand(["auth", "check", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(
			parseAuthCommand(["auth", "check", "--json", "--credentials", "--no-refresh", "--provider", "openai"]),
		).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: true,
			credentials: true,
			noRefresh: true,
		});
	});

	test("creates an auth-check runtime without catalog storage", async () => {
		const runtime = await createAuthCheckModelRuntime(AuthStorage.inMemory());
		expect(runtime.getProvider("openai")).toBeDefined();
	});
});

// #11549: standalone auth checks must honor both configured deadlines, not just session runtimes.
describe("auth-check runtime deadlines", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	for (const scenario of [
		{ name: "OAuth refresh", tokenDelayMs: 16_000, catalogDelayMs: 0, defaultDeadlineMs: 15_000 },
		{ name: "Copilot catalog", tokenDelayMs: 0, catalogDelayMs: 6000, defaultDeadlineMs: 5000 },
	]) {
		for (const configured of [false, true]) {
			test(`${scenario.name} ${configured ? "uses the configured deadline and persists credentials" : "fails at the default deadline without publishing credentials"}`, async () => {
				vi.useFakeTimers();
				vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
					const controller = new AbortController();
					setTimeout(() => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")), milliseconds);
					return controller.signal;
				});
				const expired = { type: "oauth" as const, access: "expired", refresh: "synthetic-refresh", expires: 0 };
				const credentials = AuthStorage.inMemory({ "github-copilot": expired });
				const access = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
				const modelId = githubCopilotProvider().getModels()[0]?.id;
				if (!modelId) throw new Error("Expected a built-in Copilot model");
				let markStarted = () => {};
				const started = new Promise<void>((resolve) => {
					markStarted = resolve;
				});
				const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					const url = input instanceof Request ? input.url : String(input);
					const signal = init?.signal;
					if (!signal) throw new Error("Expected an OAuth-owned request signal");
					const tokenRequest = url.includes("/copilot_internal/v2/token");
					if (!tokenRequest && url !== "https://api.individual.githubcopilot.com/models") {
						throw new Error(`Unexpected fetch URL: ${url}`);
					}
					const body = tokenRequest
						? { token: access, expires_at: 9999999999 }
						: {
								data: [
									{
										id: modelId,
										model_picker_enabled: true,
										policy: { state: "enabled" },
										capabilities: { supports: { tool_calls: true } },
									},
								],
							};
					const delayMs = tokenRequest ? scenario.tokenDelayMs : scenario.catalogDelayMs;
					const response = () =>
						new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
					signal.throwIfAborted();
					if (delayMs === 0) return Promise.resolve(response());
					return new Promise((resolve, reject) => {
						const abort = () => {
							clearTimeout(timer);
							reject(signal.reason);
						};
						const timer = setTimeout(() => {
							signal.removeEventListener("abort", abort);
							resolve(response());
						}, delayMs);
						signal.addEventListener("abort", abort, { once: true });
						markStarted();
					});
				});
				vi.stubGlobal("fetch", fetchMock);
				const runtime = await createAuthCheckModelRuntime(
					credentials,
					configured ? { oauthRefreshTimeoutMs: 30_000, githubCopilotModelsTimeoutMs: 60_000 } : undefined,
				);
				expect(fetchMock).not.toHaveBeenCalled();
				const result = checkProviderAuth(parseArgs(["--provider", "github-copilot"]), runtime, { refresh: true });
				let settled = false;
				void result.then(() => {
					settled = true;
				});
				await started;
				await vi.advanceTimersByTimeAsync(scenario.defaultDeadlineMs - 1);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				if (configured) {
					expect(settled).toBe(false);
					await vi.advanceTimersByTimeAsync(
						scenario.tokenDelayMs + scenario.catalogDelayMs - scenario.defaultDeadlineMs,
					);
					await expect(result).resolves.toEqual({
						status: "ready",
						provider: "github-copilot",
						authType: "oauth",
					});
					expect(await credentials.read("github-copilot")).toMatchObject({
						type: "oauth",
						access,
						refresh: "synthetic-refresh",
						availableModelIds: [modelId],
					});
				} else {
					await expect(result).resolves.toEqual({
						status: "invalid",
						provider: "github-copilot",
						reason: "invalid_state",
					});
					expect(await credentials.read("github-copilot")).toEqual(expired);
				}
				expect(fetchMock).toHaveBeenCalledTimes(configured || scenario.catalogDelayMs > 0 ? 2 : 1);
			});
		}
	}
});
