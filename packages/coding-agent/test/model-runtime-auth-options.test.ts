import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthType, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type CreateModelRuntimeOptions, ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "amazon-bedrock", name: "Amazon Bedrock" }),
					method: expect.objectContaining({ name: "AWS credentials or bearer token" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "google-vertex", name: "Google Vertex AI" }),
					method: expect.objectContaining({ name: "Google Cloud credentials" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("distinguishes subscription OAuth from generic OAuth sign-in", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "anthropic-access",
					refresh: "anthropic-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				openrouter: {
					type: "oauth",
					access: "openrouter-key",
					refresh: "",
					expires: Number.MAX_SAFE_INTEGER,
				},
				radius: {
					type: "oauth",
					access: "radius-access",
					refresh: "radius-refresh",
					expires: Date.now() + 60 * 60_000,
				},
			}),
			modelsPath: null,
		});

		expect(runtime.isUsingOAuth("anthropic")).toBe(true);
		expect(runtime.isUsingSubscription("anthropic")).toBe(true);
		expect(runtime.isUsingOAuth("openrouter")).toBe(true);
		expect(runtime.isUsingSubscription("openrouter")).toBe(false);
		expect(runtime.isUsingOAuth("radius")).toBe(true);
		expect(runtime.isUsingSubscription("radius")).toBe(false);
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("does not cancel an extension OAuth refresh with the request", async () => {
		const credentials = AuthStorage.inMemory({
			"extension-oauth": {
				type: "oauth",
				access: "expired",
				refresh: "refresh",
				expires: 0,
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		let refreshSignal: AbortSignal | undefined;
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential, signal) => {
					refreshSignal = signal;
					return { ...credential, expires: Date.now() + 60_000 };
				},
				getApiKey: (credential) => credential.access,
			},
			models: [testModel("extension-model")],
		});
		const controller = new AbortController();

		await runtime.getAuth("extension-oauth", { signal: controller.signal });
		expect(refreshSignal).toBeInstanceOf(AbortSignal);
		const reason = new Error("cancelled");
		controller.abort(reason);
		// A started refresh may already have rotated the refresh token and must be persisted.
		expect(refreshSignal?.aborted).toBe(false);
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				isSubscription: true,
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription", isSubscription: true },
		});
	});
});

// #11549: exercise captured SDK deadlines through the real lazy OAuth provider and credential store.
describe("ModelRuntime OAuth and Copilot deadlines", () => {
	const cleanups: Array<() => void> = [];
	const expiredCredential = { type: "oauth" as const, access: "expired", refresh: "synthetic-refresh", expires: 0 };
	const accessToken = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
	const configuredTimeouts = { oauthRefreshTimeoutMs: 30_000, githubCopilotModelsTimeoutMs: 60_000 };
	const resourceLoaderOptions = {
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	};
	const scenarios = [
		{ name: "OAuth refresh", tokenDelayMs: 16_000, catalogDelayMs: 0, defaultDeadlineMs: 15_000 },
		{ name: "Copilot catalog", tokenDelayMs: 0, catalogDelayMs: 6000, defaultDeadlineMs: 5000 },
	];

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected fetch during fixture construction")));
	});

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function temporaryDirectory(): string {
		const directory = mkdtempSync(join(tmpdir(), "pi-runtime-deadlines-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		return directory;
	}

	function useFakeDeadlineTimers(): void {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")), milliseconds);
			return controller.signal;
		});
	}

	function delayedResponse(body: unknown, signal: AbortSignal, delayMs: number): Promise<Response> {
		const response = () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
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
		});
	}

	function stubCopilotFetch(tokenDelayMs: number, catalogDelayMs: number, expectedStarts = 1) {
		const modelId = githubCopilotProvider().getModels()[0]?.id;
		if (!modelId) throw new Error("Expected a built-in Copilot model");
		let starts = 0;
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			const signal = init?.signal;
			if (!signal) throw new Error("Expected an OAuth-owned request signal");
			if (url.includes("/copilot_internal/v2/token")) {
				if (tokenDelayMs > 0 && ++starts === expectedStarts) markStarted();
				return delayedResponse({ token: accessToken, expires_at: 9999999999 }, signal, tokenDelayMs);
			}
			if (url === "https://api.individual.githubcopilot.com/models") {
				if (tokenDelayMs === 0 && ++starts === expectedStarts) markStarted();
				return delayedResponse(
					{
						data: [
							{
								id: modelId,
								model_picker_enabled: true,
								policy: { state: "enabled" },
								capabilities: { supports: { tool_calls: true } },
							},
						],
					},
					signal,
					catalogDelayMs,
				);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		return { started, modelId, fetchMock };
	}

	async function createRuntime(options: CreateModelRuntimeOptions = {}) {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("github-copilot", async () => expiredCredential);
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
			...options,
		});
		return { runtime, credentials };
	}

	async function createServices(settingsManager: SettingsManager, modelRuntime?: ModelRuntime) {
		const agentDir = temporaryDirectory();
		const credentials = AuthStorage.inMemory();
		if (!modelRuntime) vi.spyOn(AuthStorage, "create").mockReturnValueOnce(credentials);
		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions,
		});
		// Seed after construction so startup availability checks cannot consume the test refresh.
		if (!modelRuntime) await credentials.modify("github-copilot", async () => expiredCredential);
		return { ...services, runtime: services.modelRuntime, credentials };
	}

	async function createSession(settingsManager: SettingsManager, modelRuntime?: ModelRuntime) {
		const agentDir = temporaryDirectory();
		const credentials = AuthStorage.inMemory();
		if (!modelRuntime) vi.spyOn(AuthStorage, "create").mockReturnValueOnce(credentials);
		const resourceLoader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager,
			...resourceLoaderOptions,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: agentDir,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(agentDir),
			tools: [],
		});
		cleanups.push(() => session.dispose());
		if (!modelRuntime) await credentials.modify("github-copilot", async () => expiredCredential);
		return { runtime: session.modelRuntime, credentials };
	}

	function authOutcome(runtime: ModelRuntime) {
		return runtime.getAuth("github-copilot").then(
			(auth) => ({ auth }),
			(error: unknown) => ({ error }),
		);
	}

	async function expectCapturedDeadlines(
		defaults: { runtime: ModelRuntime; credentials: CredentialStore },
		configured: { runtime: ModelRuntime; credentials: CredentialStore },
		scenario: (typeof scenarios)[number],
	) {
		expect(fetch).not.toHaveBeenCalled();
		expect(await defaults.credentials.read("github-copilot")).toEqual(expiredCredential);
		expect(await configured.credentials.read("github-copilot")).toEqual(expiredCredential);
		useFakeDeadlineTimers();
		const { started, modelId } = stubCopilotFetch(scenario.tokenDelayMs, scenario.catalogDelayMs, 2);
		let defaultSettled = false;
		let configuredSettled = false;
		const defaultAuth = authOutcome(defaults.runtime).then((outcome) => {
			defaultSettled = true;
			return outcome;
		});
		const configuredAuth = authOutcome(configured.runtime).then((outcome) => {
			configuredSettled = true;
			return outcome;
		});
		await started;
		await vi.advanceTimersByTimeAsync(scenario.defaultDeadlineMs - 1);
		expect(defaultSettled).toBe(false);
		// AuthStorage reads also take the lock held by the pending refresh.
		expect(configuredSettled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await defaultAuth).toHaveProperty("error");
		expect(await defaults.credentials.read("github-copilot")).toEqual(expiredCredential);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await configuredAuth).toMatchObject({ auth: { auth: { apiKey: accessToken } } });
		expect(await configured.credentials.read("github-copilot")).toMatchObject({
			access: accessToken,
			availableModelIds: [modelId],
		});
	}

	it.each(scenarios)("captures independent constructor limits for $name", async (scenario) => {
		const defaults = await createRuntime();
		const configured = await createRuntime(configuredTimeouts);
		await expectCapturedDeadlines(defaults, configured, scenario);
	});

	for (const [name, create] of [
		["session services", createServices],
		["SDK session", createSession],
	] as const) {
		it.each(scenarios)(`applies in-memory settings to default-created ${name} for $name`, async (scenario) => {
			const defaults = await create(SettingsManager.inMemory());
			const configured = await create(SettingsManager.inMemory(configuredTimeouts));
			await expectCapturedDeadlines(defaults, configured, scenario);
		});

		it.each(
			(["invalid", "shorter", "longer"] as const).flatMap((settingKind) =>
				scenarios.map((scenario) => ({ ...scenario, settingKind })),
			),
		)(
			`keeps an explicit $name limit authoritative in ${name} with $settingKind session settings`,
			async ({ settingKind, tokenDelayMs, catalogDelayMs, defaultDeadlineMs }) => {
				const explicit = await createRuntime(settingKind === "longer" ? {} : configuredTimeouts);
				const settingsManager = SettingsManager.inMemory(
					settingKind === "invalid"
						? { oauthRefreshTimeoutMs: null as unknown as number, githubCopilotModelsTimeoutMs: 0 }
						: settingKind === "shorter"
							? { oauthRefreshTimeoutMs: 1, githubCopilotModelsTimeoutMs: 1 }
							: configuredTimeouts,
				);
				const created = await create(settingsManager, explicit.runtime);
				expect(created.runtime).toBe(explicit.runtime);
				expect(fetch).not.toHaveBeenCalled();
				useFakeDeadlineTimers();
				const { started, modelId } = stubCopilotFetch(tokenDelayMs, catalogDelayMs);
				const outcome = authOutcome(created.runtime);
				await started;
				await vi.advanceTimersByTimeAsync(
					settingKind === "longer" ? defaultDeadlineMs : tokenDelayMs + catalogDelayMs,
				);
				if (settingKind === "longer") {
					expect(await outcome).toHaveProperty("error");
					expect(await explicit.credentials.read("github-copilot")).toEqual(expiredCredential);
				} else {
					expect(await outcome).toMatchObject({ auth: { auth: { apiKey: accessToken } } });
					expect(await explicit.credentials.read("github-copilot")).toMatchObject({
						access: accessToken,
						availableModelIds: [modelId],
					});
				}
			},
		);
	}

	for (const change of ["reload", "project trust admission"] as const) {
		it.each(scenarios)(`captures $name until a new runtime is constructed after ${change}`, async (scenario) => {
			const storage = new InMemorySettingsStorage();
			if (change === "project trust admission") {
				storage.withLock("project", () => JSON.stringify(configuredTimeouts));
			}
			const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
			const original = await createServices(settingsManager);
			if (change === "reload") {
				storage.withLock("global", () => JSON.stringify(configuredTimeouts));
				await original.resourceLoader.reload();
			} else {
				await original.resourceLoader.reload({ resolveProjectTrust: async () => true });
				expect(settingsManager.isProjectTrusted()).toBe(true);
			}
			expect(settingsManager.getOAuthRefreshTimeoutMs()).toBe(30_000);
			expect(settingsManager.getGitHubCopilotModelsTimeoutMs()).toBe(60_000);
			const reconstructed = await createServices(settingsManager);
			await expectCapturedDeadlines(original, reconstructed, scenario);
		});
	}

	for (const key of ["oauthRefreshTimeoutMs", "githubCopilotModelsTimeoutMs"] as const) {
		it.each([null, 0, -1, 0.5, "60000", "disabled", NaN, Infinity, 2_147_483_648])(
			`rejects invalid ${key} %s before provider calls or storage access`,
			async (value) => {
				const credentials = new InMemoryCredentialStore();
				const storageCalls = [
					vi.spyOn(credentials, "read"),
					vi.spyOn(credentials, "list"),
					vi.spyOn(credentials, "modify"),
					vi.spyOn(credentials, "delete"),
				];
				const directory = temporaryDirectory();
				const authPath = join(directory, "uncreated", "auth.json");
				const fetchMock = vi.fn();
				vi.stubGlobal("fetch", fetchMock);
				await expect(
					ModelRuntime.create({ credentials, authPath, modelsPath: null, [key]: value as number }),
				).rejects.toThrow(new RangeError(`Invalid ${key}: expected an integer from 1 to 2147483647 milliseconds`));
				await expect(ModelRuntime.create({ authPath, modelsPath: null, [key]: value as number })).rejects.toThrow(
					RangeError,
				);
				for (const call of storageCalls) expect(call).not.toHaveBeenCalled();
				expect(fetchMock).not.toHaveBeenCalled();
				expect(existsSync(join(directory, "uncreated"))).toBe(false);
			},
		);
	}

	it.each([1, 2_147_483_647])("accepts and applies the timeout boundary %i", async (timeout) => {
		const { runtime, credentials } = await createRuntime({
			oauthRefreshTimeoutMs: timeout,
			githubCopilotModelsTimeoutMs: timeout,
		});
		useFakeDeadlineTimers();
		const { started, modelId } = stubCopilotFetch(0, 2);
		const outcome = authOutcome(runtime);
		await started;
		await vi.advanceTimersByTimeAsync(2);
		if (timeout === 1) {
			expect(await outcome).toHaveProperty("error");
			expect(await credentials.read("github-copilot")).toEqual(expiredCredential);
		} else {
			expect(await outcome).toMatchObject({ auth: { auth: { apiKey: accessToken } } });
			expect(await credentials.read("github-copilot")).toMatchObject({ availableModelIds: [modelId] });
		}
	});
});
