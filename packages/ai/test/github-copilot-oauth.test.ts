import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createGitHubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { createModels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";

const neverAbortedSignal = new AbortController().signal;
const githubCopilotOAuth = createGitHubCopilotOAuth(5000);

const testCopilotAccessToken = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";
const testCopilotModelsUrl = "https://api.individual.githubcopilot.com/models";

function jsonResponse(body: unknown, status: number = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function requireModelId(models: readonly { id: string }[], index: number): string {
	const model = models[index];
	if (!model) throw new Error(`Expected a GitHub Copilot model at index ${index}`);
	return model.id;
}

function stubGitHubCopilotLoginFetch(options: {
	models: (signal: AbortSignal) => Response | Promise<Response>;
	policy?: (modelId: string, signal: AbortSignal) => Response | Promise<Response>;
}): void {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = getUrl(input);
		if (url.endsWith("/login/device/code")) {
			return jsonResponse({
				device_code: "device-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://github.com/login/device",
				interval: 1,
				expires_in: 900,
			});
		}
		if (url.endsWith("/login/oauth/access_token")) {
			return jsonResponse({ access_token: "ghu_refresh_token" });
		}
		if (url.includes("/copilot_internal/v2/token")) {
			return jsonResponse({ token: testCopilotAccessToken, expires_at: 9999999999 });
		}
		if (url === testCopilotModelsUrl) return options.models(init?.signal ?? neverAbortedSignal);
		if (url.startsWith(`${testCopilotModelsUrl}/`) && url.endsWith("/policy")) {
			if (!options.policy) throw new Error(`Unexpected policy request: ${url}`);
			return options.policy(
				url.slice(`${testCopilotModelsUrl}/`.length, -"/policy".length),
				init?.signal ?? neverAbortedSignal,
			);
		}
		throw new Error(`Unexpected fetch URL: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
}

function loginGitHubCopilotForTest(options: {
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	onProgress?(message: string): void;
	signal?: AbortSignal;
	modelCatalogTimeoutMs?: number;
}) {
	return createGitHubCopilotOAuth(options.modelCatalogTimeoutMs ?? 5000).login({
		signal: options.signal ?? neverAbortedSignal,
		prompt: (prompt) => {
			if (prompt.type !== "text") throw new Error(`Unexpected prompt: ${prompt.type}`);
			return options.onPrompt({ message: prompt.message, placeholder: prompt.placeholder, allowEmpty: true });
		},
		notify: (event) => {
			if (event.type === "device_code") {
				const { type: _, ...info } = event;
				options.onDeviceCode(info);
			}
			if (event.type === "progress") options.onProgress?.(event.message);
		},
	});
}

async function refreshGitHubCopilotModelsForTest(
	data: readonly unknown[],
	proxyHost: string = "proxy.individual.githubcopilot.com",
) {
	const accessToken = `tid=test;exp=9999999999;proxy-ep=${proxyHost};`;
	const modelsUrl = `https://${proxyHost.replace(/^proxy\./, "api.")}/models`;
	const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = getUrl(input);

		if (url.includes("/copilot_internal/v2/token")) {
			return jsonResponse({
				token: accessToken,
				expires_at: 9999999999,
			});
		}

		if (url === modelsUrl) {
			expect(init?.headers).toMatchObject({
				Authorization: `Bearer ${accessToken}`,
			});
			return jsonResponse({ data });
		}

		throw new Error(`Unexpected fetch URL: ${url}`);
	});

	vi.stubGlobal("fetch", fetchMock);
	return githubCopilotOAuth.refresh(
		{
			type: "oauth",
			access: "old-access-token",
			refresh: "ghu_refresh_token",
			expires: 0,
		},
		neverAbortedSignal,
	);
}

function useFakeDeadlineTimers(): void {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")), milliseconds);
		return controller.signal;
	});
}

function delayedCatalogResponse(signal: AbortSignal, delayMs: number, body: unknown): Promise<Response> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve(jsonResponse(body));
		}, delayMs);
		signal.addEventListener("abort", abort, { once: true });
	});
}

function unfinishedCatalogResponse(signal: AbortSignal): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				signal.throwIfAborted();
				signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
			},
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function createRefreshingCopilotModels(modelCatalogTimeoutMs?: number) {
	const credential = {
		type: "oauth" as const,
		access: "old-access-token",
		refresh: "ghu_refresh_token",
		expires: 0,
	};
	const store = new InMemoryCredentialStore();
	await store.modify("github-copilot", async () => credential);
	const models = createModels({ credentials: store });
	models.setProvider(githubCopilotProvider({ modelCatalogTimeoutMs }));
	return { models, store, credential };
}

function enabledCatalog() {
	const modelId = requireModelId(githubCopilotProvider().getModels(), 0);
	return {
		data: [
			{
				id: modelId,
				model_picker_enabled: true,
				policy: { state: "enabled" },
				capabilities: { supports: { tool_calls: true } },
			},
		],
	};
}

describe("GitHub Copilot OAuth device flow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	// #11549: catalog deadlines are per provider and include response-body consumption.
	it("isolates default and configured lazy providers while refreshing expired credentials", async () => {
		useFakeDeadlineTimers();
		const catalog = enabledCatalog();
		let catalogRequests = 0;
		let bothCatalogsStarted = () => {};
		const started = new Promise<void>((resolve) => {
			bothCatalogsStarted = resolve;
		});
		stubGitHubCopilotLoginFetch({
			models: (signal) => {
				catalogRequests += 1;
				if (catalogRequests === 2) bothCatalogsStarted();
				return delayedCatalogResponse(signal, 6000, catalog);
			},
		});
		const defaults = await createRefreshingCopilotModels();
		const configured = await createRefreshingCopilotModels(60_000);
		const defaultAuth = defaults.models.getAuth("github-copilot");
		const defaultFailure = expect(defaultAuth).rejects.toThrow();
		const configuredAuth = configured.models.getAuth("github-copilot");
		await started;
		await vi.advanceTimersByTimeAsync(4999);
		expect(await defaults.store.read("github-copilot")).toEqual(defaults.credential);
		expect(await configured.store.read("github-copilot")).toEqual(configured.credential);
		await vi.advanceTimersByTimeAsync(1);
		await defaultFailure;
		expect(await defaults.store.read("github-copilot")).toEqual(defaults.credential);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(configuredAuth).resolves.toBeDefined();
		expect(await configured.store.read("github-copilot")).toMatchObject({
			access: testCopilotAccessToken,
			availableModelIds: catalog.data.map((model) => model.id),
		});
		expect(catalogRequests).toBe(2);
	});

	it("aborts an unfinished catalog body without publishing refreshed credentials", async () => {
		useFakeDeadlineTimers();
		let catalogSignal: AbortSignal | undefined;
		let catalogStarted = () => {};
		const started = new Promise<void>((resolve) => {
			catalogStarted = resolve;
		});
		stubGitHubCopilotLoginFetch({
			models: (signal) => {
				catalogSignal = signal;
				catalogStarted();
				return unfinishedCatalogResponse(signal);
			},
		});
		const { models, store, credential } = await createRefreshingCopilotModels(25);
		const failure = expect(models.getAuth("github-copilot")).rejects.toThrow();
		await started;
		await vi.advanceTimersByTimeAsync(24);
		expect(catalogSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await failure;
		expect(catalogSignal?.aborted).toBe(true);
		expect(await store.read("github-copilot")).toEqual(credential);
	});

	it.each([null, 0, -1, 0.5, "60000", "disabled", NaN, Infinity, 2_147_483_648])(
		"rejects invalid provider catalog timeout %s before any request",
		(value) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			expect(() => githubCopilotProvider({ modelCatalogTimeoutMs: value as number })).toThrow(RangeError);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("allows login catalogs completing after the former five-second budget", async () => {
		useFakeDeadlineTimers();
		const catalog = enabledCatalog();
		stubGitHubCopilotLoginFetch({ models: (signal) => delayedCatalogResponse(signal, 6000, catalog) });
		const login = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
			modelCatalogTimeoutMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(6999);
		await vi.advanceTimersByTimeAsync(1);
		await expect(login).resolves.toMatchObject({
			access: testCopilotAccessToken,
			availableModelIds: catalog.data.map((model) => model.id),
		});
	});

	it("allows a login catalog retry after a delay beyond five seconds", async () => {
		useFakeDeadlineTimers();
		const catalog = enabledCatalog();
		let catalogRequests = 0;
		stubGitHubCopilotLoginFetch({
			models: () => {
				catalogRequests += 1;
				return catalogRequests === 1
					? jsonResponse({ error: "throttled" }, 429, { "Retry-After": "6" })
					: jsonResponse(catalog);
			},
		});
		const login = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
			modelCatalogTimeoutMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(6999);
		expect(catalogRequests).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(login).resolves.toMatchObject({ availableModelIds: catalog.data.map((model) => model.id) });
		expect(catalogRequests).toBe(2);
	});

	it("does not retry a login catalog when Retry-After exceeds its configured budget", async () => {
		useFakeDeadlineTimers();
		let catalogRequests = 0;
		stubGitHubCopilotLoginFetch({
			models: () => {
				catalogRequests += 1;
				return jsonResponse({ error: "throttled" }, 429, { "Retry-After": "0.1" });
			},
		});
		const failure = expect(
			loginGitHubCopilotForTest({
				onDeviceCode: () => {},
				onPrompt: async () => "",
				modelCatalogTimeoutMs: 25,
			}),
		).rejects.toThrow("429");
		await vi.advanceTimersByTimeAsync(1000);
		await failure;
		expect(catalogRequests).toBe(1);
	});

	it("keeps login catalog retries capped at two with a larger budget", async () => {
		useFakeDeadlineTimers();
		let catalogRequests = 0;
		stubGitHubCopilotLoginFetch({
			models: () => {
				catalogRequests += 1;
				return jsonResponse({ error: "throttled" }, 429, { "Retry-After": "0" });
			},
		});
		const failure = expect(
			loginGitHubCopilotForTest({
				onDeviceCode: () => {},
				onPrompt: async () => "",
				modelCatalogTimeoutMs: 60_000,
			}),
		).rejects.toThrow("429");
		await vi.advanceTimersByTimeAsync(1005);
		await failure;
		expect(catalogRequests).toBe(3);
	});

	it("bounds login error-body reading by the configured catalog deadline", async () => {
		useFakeDeadlineTimers();
		let catalogSignal: AbortSignal | undefined;
		stubGitHubCopilotLoginFetch({
			models: (signal) => {
				catalogSignal = signal;
				const response = unfinishedCatalogResponse(signal);
				return new Response(response.body, { status: 429, headers: { "Retry-After": "1" } });
			},
		});
		const failure = expect(
			loginGitHubCopilotForTest({
				onDeviceCode: () => {},
				onPrompt: async () => "",
				modelCatalogTimeoutMs: 25,
			}),
		).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(1024);
		expect(catalogSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await failure;
		expect(catalogSignal?.aborted).toBe(true);
	});

	it("immediately aborts an in-flight login catalog when its caller cancels", async () => {
		useFakeDeadlineTimers();
		const controller = new AbortController();
		let catalogSignal: AbortSignal | undefined;
		stubGitHubCopilotLoginFetch({
			models: (signal) => {
				catalogSignal = signal;
				return delayedCatalogResponse(signal, 6000, enabledCatalog());
			},
		});
		const failure = expect(
			loginGitHubCopilotForTest({
				onDeviceCode: () => {},
				onPrompt: async () => "",
				modelCatalogTimeoutMs: 60_000,
				signal: controller.signal,
			}),
		).rejects.toThrow("Login cancelled");
		await vi.advanceTimersByTimeAsync(1000);
		expect(catalogSignal?.aborted).toBe(false);
		controller.abort(new Error("Login cancelled"));
		await failure;
		expect(catalogSignal?.aborted).toBe(true);
	});

	it("keeps policy attempts at five seconds with a larger catalog deadline", async () => {
		useFakeDeadlineTimers();
		const catalog = enabledCatalog();
		for (const model of catalog.data) model.policy.state = "unconfigured";
		let policySignal: AbortSignal | undefined;
		let policyRequests = 0;
		stubGitHubCopilotLoginFetch({
			models: () => jsonResponse(catalog),
			policy: (_modelId, signal) => {
				policyRequests += 1;
				policySignal = signal;
				return delayedCatalogResponse(signal, 6000, {});
			},
		});
		const login = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
			modelCatalogTimeoutMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(5999);
		expect(policySignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(login).resolves.toMatchObject({ access: testCopilotAccessToken });
		expect(policySignal?.aborted).toBe(true);
		expect(policyRequests).toBe(1);
	});

	it("filters models to the authenticated account picker catalog", async () => {
		const provider = githubCopilotProvider();
		const providerModels = provider.getModels();
		const pickerModelId = requireModelId(providerModels, 0);
		const disabledModelId = requireModelId(providerModels, 1);
		const hiddenModelId = requireModelId(providerModels, 2);

		const credentials = await refreshGitHubCopilotModelsForTest([
			{
				id: pickerModelId,
				model_picker_enabled: true,
				capabilities: { supports: { tool_calls: true } },
			},
			{
				id: disabledModelId,
				model_picker_enabled: true,
				policy: { state: "disabled" },
				capabilities: { supports: { tool_calls: true } },
			},
			{
				id: hiddenModelId,
				model_picker_enabled: false,
				policy: { state: "enabled" },
				capabilities: { supports: { tool_calls: true } },
			},
		]);
		expect(credentials.availableModelIds).toEqual([pickerModelId]);

		const store = new InMemoryCredentialStore();
		await store.modify("github-copilot", async () => ({ ...credentials, type: "oauth" }));
		const models = createModels({ credentials: store });
		models.setProvider(provider);
		expect((await models.getAvailable("github-copilot")).map((model) => model.id)).toEqual([pickerModelId]);
	});

	it("falls back to explicitly enabled policy models when the picker catalog is empty", async () => {
		const provider = githubCopilotProvider();
		const enabledModelId = requireModelId(provider.getModels(), 0);
		const credentials = await refreshGitHubCopilotModelsForTest([
			{
				id: enabledModelId,
				model_picker_enabled: false,
				policy: { state: "enabled" },
				capabilities: { supports: { tool_calls: true } },
			},
			{
				id: "policy-disabled-model",
				model_picker_enabled: false,
				policy: { state: "disabled" },
				capabilities: { supports: { tool_calls: true } },
			},
			{
				id: "unconfigured-model",
				model_picker_enabled: false,
				capabilities: { supports: { tool_calls: true } },
			},
			{
				id: "tool-incapable-model",
				model_picker_enabled: false,
				policy: { state: "enabled" },
				capabilities: { supports: { tool_calls: false } },
			},
		]);

		expect(credentials.availableModelIds).toEqual([enabledModelId]);

		const store = new InMemoryCredentialStore();
		await store.modify("github-copilot", async () => ({ ...credentials, type: "oauth" }));
		const models = createModels({ credentials: store });
		models.setProvider(provider);
		expect((await models.getAvailable("github-copilot")).map((model) => model.id)).toEqual([enabledModelId]);
	});

	it("does not fall back to policy models for non-Individual accounts", async () => {
		const credentials = await refreshGitHubCopilotModelsForTest(
			[
				{
					id: "gpt-4.1",
					model_picker_enabled: false,
					policy: { state: "enabled" },
					capabilities: { supports: { tool_calls: true } },
				},
			],
			"proxy.business.githubcopilot.com",
		);

		expect(credentials.availableModelIds).toEqual([]);
	});

	it("does not retry model catalog throttling during credential refresh", async () => {
		let catalogRequestCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url.includes("/copilot_internal/v2/token")) {
					return jsonResponse({ token: testCopilotAccessToken, expires_at: 9999999999 });
				}
				if (url === testCopilotModelsUrl) {
					catalogRequestCount += 1;
					return jsonResponse({ error: "too many requests" }, 429, { "Retry-After": "0" });
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		await expect(
			createGitHubCopilotOAuth(60_000).refresh(
				{
					type: "oauth",
					access: "old-access-token",
					refresh: "ghu_refresh_token",
					expires: 0,
				},
				neverAbortedSignal,
			),
		).rejects.toThrow("429");
		expect(catalogRequestCount).toBe(1);
	});

	it("reports device-code details through onDeviceCode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 1,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				return jsonResponse({ access_token: "ghu_refresh_token" });
			}

			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.endsWith("/models")) {
				return jsonResponse({ data: [] });
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onDeviceCode = vi.fn();
		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode,
			onPrompt: async () => "",
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(onDeviceCode).toHaveBeenCalledWith({
			userCode: "ABCD-EFGH",
			verificationUri: "https://github.com/login/device",
			intervalSeconds: 1,
			expiresInSeconds: 900,
		});
		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;
	});

	it("updates only known, tool-capable, unconfigured account model policies", async () => {
		vi.useFakeTimers();

		const providerModels = githubCopilotProvider().getModels();
		const configuredModelId = requireModelId(providerModels, 0);
		const unconfiguredModelId = requireModelId(providerModels, 1);
		const toolIncapableModelId = requireModelId(providerModels, 2);
		let catalogRequestCount = 0;
		const policyModelIds: string[] = [];
		stubGitHubCopilotLoginFetch({
			models: () => {
				catalogRequestCount += 1;
				return jsonResponse({
					data: [
						{
							id: configuredModelId,
							model_picker_enabled: true,
							policy: { state: "enabled" },
							capabilities: { supports: { tool_calls: true } },
						},
						{
							id: unconfiguredModelId,
							model_picker_enabled: true,
							policy: { state: "unconfigured" },
							capabilities: { supports: { tool_calls: true } },
						},
						{
							id: "remote-only-model",
							model_picker_enabled: true,
							policy: { state: "unconfigured" },
							capabilities: { supports: { tool_calls: true } },
						},
						{
							id: toolIncapableModelId,
							model_picker_enabled: true,
							policy: { state: "unconfigured" },
							capabilities: { supports: { tool_calls: false } },
						},
					],
				});
			},
			policy: (modelId) => {
				policyModelIds.push(modelId);
				return new Response("", { status: 200 });
			},
		});

		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
		});
		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;

		expect(catalogRequestCount).toBe(1);
		expect(policyModelIds).toEqual([unconfiguredModelId]);
	});

	it("retries a throttled policy update after Retry-After", async () => {
		vi.useFakeTimers();

		const modelId = requireModelId(githubCopilotProvider().getModels(), 0);
		let policyRequestCount = 0;
		stubGitHubCopilotLoginFetch({
			models: () =>
				jsonResponse({
					data: [{ id: modelId, model_picker_enabled: true, policy: { state: "unconfigured" } }],
				}),
			policy: () => {
				policyRequestCount += 1;
				return policyRequestCount === 1
					? jsonResponse({ error: "too many requests" }, 429, { "Retry-After": "1" })
					: new Response("", { status: 200 });
			},
		});

		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(policyRequestCount).toBe(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(policyRequestCount).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await loginPromise;

		expect(policyRequestCount).toBe(2);
	});

	it("continues policy updates after a transport failure", async () => {
		vi.useFakeTimers();

		const providerModels = githubCopilotProvider().getModels();
		const modelIds = [requireModelId(providerModels, 0), requireModelId(providerModels, 1)];
		const policyModelIds: string[] = [];
		stubGitHubCopilotLoginFetch({
			models: () =>
				jsonResponse({
					data: modelIds.map((id) => ({ id, model_picker_enabled: true, policy: { state: "unconfigured" } })),
				}),
			policy: (modelId) => {
				policyModelIds.push(modelId);
				if (policyModelIds.length === 1) throw new Error("fetch failed");
				return new Response("", { status: 200 });
			},
		});

		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
		});
		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;

		expect(policyModelIds).toEqual(modelIds);
	});

	it("stops policy updates and persists authentication when the retry delay exceeds the login budget", async () => {
		vi.useFakeTimers();

		const providerModels = githubCopilotProvider().getModels();
		const firstModelId = requireModelId(providerModels, 0);
		const secondModelId = requireModelId(providerModels, 1);
		const policyModelIds: string[] = [];
		stubGitHubCopilotLoginFetch({
			models: () =>
				jsonResponse({
					data: [
						{ id: firstModelId, model_picker_enabled: true, policy: { state: "unconfigured" } },
						{ id: secondModelId, model_picker_enabled: true, policy: { state: "unconfigured" } },
					],
				}),
			policy: (modelId) => {
				policyModelIds.push(modelId);
				return jsonResponse({ error: "too many requests" }, 429, { "Retry-After": "5" });
			},
		});

		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(githubCopilotProvider());
		const loginPromise = models.login("github-copilot", "oauth", {
			signal: neverAbortedSignal,
			prompt: async () => "",
			notify: () => {},
		});

		await vi.advanceTimersByTimeAsync(1000);
		const credential = await loginPromise;
		expect(credential).toMatchObject({ type: "oauth", access: testCopilotAccessToken });
		expect(policyModelIds).toEqual([firstModelId]);
		expect(await store.read("github-copilot")).toEqual(credential);
	});

	it("rejects a non-http(s) verification_uri before it reaches onDeviceCode", async () => {
		// A malicious enterprise OAuth server could return a verification_uri that
		// the browser launcher would otherwise hand to the OS. Ensure such values
		// are rejected at the deserialization boundary.
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "$(id>/tmp/pwned)",
					interval: 1,
					expires_in: 900,
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onDeviceCode = vi.fn();
		await expect(
			loginGitHubCopilotForTest({
				onDeviceCode,
				onPrompt: async () => "",
			}),
		).rejects.toThrow(/Untrusted verification_uri/);
		expect(onDeviceCode).not.toHaveBeenCalled();
	});

	it("normalizes verification_uri before it reaches onDeviceCode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const rawVerificationUri = "https://github.com/login/\x1b]8;;evil";
		const normalizedVerificationUri = new URL(rawVerificationUri).href;
		expect(normalizedVerificationUri).not.toBe(rawVerificationUri);

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: rawVerificationUri,
					interval: 1,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				return jsonResponse({ access_token: "ghu_refresh_token" });
			}

			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.endsWith("/models")) {
				return jsonResponse({ data: [] });
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onDeviceCode = vi.fn();
		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode,
			onPrompt: async () => "",
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(onDeviceCode).toHaveBeenCalledWith({
			userCode: "ABCD-EFGH",
			verificationUri: normalizedVerificationUri,
			intervalSeconds: 1,
			expiresInSeconds: 900,
		});
		expect(onDeviceCode).not.toHaveBeenCalledWith(expect.objectContaining({ verificationUri: rawVerificationUri }));

		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;
	});

	it("waits before polling and increases the interval after slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
			jsonResponse({ error: "slow_down", error_description: "slow down", interval: 7 }),
			jsonResponse({ access_token: "ghu_refresh_token" }),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("scope=read%3Auser");
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("device_code=device-code");
				expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
				const response = accessTokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra access token poll");
				}
				return response;
			}

			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.endsWith("/models")) {
				return jsonResponse({ data: [] });
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onProgress: () => {},
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(accessTokenPollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(4999);
		expect(accessTokenPollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(4999);
		expect(accessTokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toHaveLength(2);

		// slow_down carried a server-provided interval of 7 seconds.
		await vi.advanceTimersByTimeAsync(6999);
		expect(accessTokenPollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		await loginPromise;

		expect(accessTokenPollTimes).toEqual([
			startTime.getTime() + 5000,
			startTime.getTime() + 10000,
			startTime.getTime() + 17000,
		]);
	});

	it("times out after repeated slow_down responses", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "slow_down", error_description: "slow down" }),
			jsonResponse({ error: "slow_down", error_description: "still too fast" }),
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
		];

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 25,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				const response = accessTokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra access token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGitHubCopilotForTest({
			onDeviceCode: () => {},
			onPrompt: async () => "",
		});
		const rejection = expect(loginPromise).rejects.toThrow(
			/Device flow timed out after one or more slow_down responses/,
		);

		await vi.advanceTimersByTimeAsync(4999);
		expect(accessTokenPollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000]);

		await vi.advanceTimersByTimeAsync(9999);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000]);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);

		await vi.advanceTimersByTimeAsync(9999);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);

		await vi.advanceTimersByTimeAsync(1);
		await rejection;

		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);
	});
});
