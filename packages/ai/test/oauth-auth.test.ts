import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { createGitHubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { openRouterOAuth } from "../src/auth/oauth/openrouter.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { createModels, type Provider } from "../src/models.ts";
import * as extensionOAuthCompatibility from "../src/oauth.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import { openaiProvider } from "../src/providers/openai.ts";

const neverAbortedSignal = new AbortController().signal;
const githubCopilotOAuth = createGitHubCopilotOAuth(5_000);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function oauthRefreshFixture(oauthRefreshTimeoutMs?: number) {
	const credentials = new InMemoryCredentialStore();
	const expired: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
	const rotated: OAuthCredential = {
		type: "oauth",
		access: "new-access",
		refresh: "new-refresh",
		expires: Date.now() + 60 * 60_000,
	};
	await credentials.modify("test-oauth", async () => expired);
	const refresh = vi.fn<OAuthAuth["refresh"]>(
		(_credential, signal) =>
			new Promise((resolve, reject) => {
				signal.throwIfAborted();
				const onAbort = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve(rotated);
				}, 16_000);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
	);
	const provider: Provider = {
		id: "test-oauth",
		name: "Test OAuth",
		auth: {
			oauth: {
				name: "Test OAuth",
				login: async () => {
					throw new Error("not used");
				},
				refresh,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [],
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
	const options = oauthRefreshTimeoutMs === undefined ? { credentials } : { credentials, oauthRefreshTimeoutMs };
	const models = createModels(options);
	models.setProvider(provider);
	return { models, credentials, expired, rotated, refresh, options };
}

describe.sequential("OAuthAuth adapters", () => {
	it("keeps the extension OAuth barrel free of built-in flow implementations", () => {
		expect(extensionOAuthCompatibility).not.toHaveProperty("loginAnthropic");
		expect(extensionOAuthCompatibility).not.toHaveProperty("anthropicOAuth");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("identifies only subscription-backed OAuth flows as subscriptions", () => {
		for (const oauth of [
			anthropicOAuth,
			openaiChatGPTOAuth,
			openaiCodexOAuth,
			githubCopilotOAuth,
			kimiCodingOAuth,
			xaiOAuth,
		]) {
			expect(oauth.isSubscription).toBe(true);
		}
		expect(openRouterOAuth.isSubscription).not.toBe(true);
	});

	it("anthropic toAuth derives the api key from the access token", async () => {
		const auth = await anthropicOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: "token" });
	});

	it("OpenAI exposes ChatGPT OAuth alongside API-key auth", () => {
		const provider = openaiProvider();
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.oauth).toMatchObject({
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
		});
	});

	it("openai-codex toAuth derives the api key from the access token", async () => {
		const auth = await openaiCodexOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: "token" });
	});

	it("openrouter derives the api key and keeps the permanent credential on refresh", async () => {
		const credential = { type: "oauth" as const, access: "token", refresh: "", expires: Number.MAX_SAFE_INTEGER };
		expect(await openRouterOAuth.toAuth(credential)).toEqual({ apiKey: "token" });
		expect(await openRouterOAuth.refresh(credential, neverAbortedSignal)).toBe(credential);
	});

	it("xAI toAuth derives the api key from the access token", async () => {
		const auth = await xaiOAuth.toAuth({ type: "oauth", access: "token", refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: "token" });
	});

	it("github-copilot toAuth derives baseUrl from the token proxy endpoint", async () => {
		const access = "tid=abc;exp=123;proxy-ep=proxy.enterprise.example;rest";
		const auth = await githubCopilotOAuth.toAuth({ type: "oauth", access, refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: access, baseUrl: "https://api.enterprise.example" });
	});

	it("github-copilot toAuth falls back to the enterprise domain, then the individual endpoint", async () => {
		const enterprise = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: "no-proxy-ep",
			refresh: "r",
			expires: 0,
			enterpriseUrl: "https://company.ghe.com",
		});
		expect(enterprise.baseUrl).toBe("https://copilot-api.company.ghe.com");

		const individual = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: "no-proxy-ep",
			refresh: "r",
			expires: 0,
		});
		expect(individual.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it("anthropic refresh exchanges the refresh token and returns a typed credential", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
			),
		);

		const refreshed = await anthropicOAuth.refresh(
			{ type: "oauth", access: "old", refresh: "old-r", expires: 0 },
			neverAbortedSignal,
		);
		expect(refreshed.type).toBe("oauth");
		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe("new-refresh");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("github-copilot refresh preserves the enterprise domain", async () => {
		const fetchedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: unknown) => {
			const url = typeof input === "string" ? input : String(input);
			fetchedUrls.push(url);
			if (url.endsWith("/models")) {
				return jsonResponse({ data: [] });
			}
			return jsonResponse({ token: "new-token", expires_at: 9999999999 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await githubCopilotOAuth.refresh(
			{
				type: "oauth",
				access: "old",
				refresh: "gh-token",
				expires: 0,
				enterpriseUrl: "company.ghe.com",
			},
			neverAbortedSignal,
		);
		expect(refreshed.access).toBe("new-token");
		expect(refreshed.enterpriseUrl).toBe("company.ghe.com");
		expect(fetchedUrls[0]).toContain("api.company.ghe.com");
	});
});

describe("OAuth through Models.getAuth (lazy load chain)", () => {
	it("resolves stored anthropic oauth credentials via the lazy flow import", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({
			type: "oauth",
			access: "oauth-access-token",
			refresh: "r",
			// Keep this beyond getAuth()'s refresh window.
			expires: Date.now() + 10 * 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(anthropicProvider());

		const model = models.getModels("anthropic")[0];
		const result = await models.getAuth(model.provider);
		expect(result?.auth.apiKey).toBe("oauth-access-token");
		expect(result?.source).toBe("OAuth");
	});

	it("resolves stored github-copilot oauth credentials including per-credential baseUrl", async () => {
		const access = "tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com;rest";
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access,
			refresh: "r",
			// Keep this beyond getAuth()'s refresh window.
			expires: Date.now() + 10 * 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(githubCopilotProvider());

		const model = models.getModels("github-copilot")[0];
		const result = await models.getAuth(model.provider);
		expect(result?.auth.apiKey).toBe(access);
		expect(result?.auth.baseUrl).toBe("https://api.business.githubcopilot.com");
	});
});

// Regression coverage for https://github.com/earendil-works/pi/issues/11549.
describe("Models.getAuth OAuth refresh deadlines", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Native AbortSignal.timeout does not advance with Vitest's fake clock.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), milliseconds);
			return controller.signal;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("keeps the default refresh pending until 15000 ms, then preserves the expired credential", async () => {
		const { models, credentials, expired, refresh } = await oauthRefreshFixture();
		const pending = models.getAuth("test-oauth");
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const rejection = expect(pending).rejects.toMatchObject({ code: "oauth", cause: { name: "TimeoutError" } });

		await vi.advanceTimersByTimeAsync(14_999);
		expect(refresh).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		expect(await credentials.read("test-oauth")).toEqual(expired);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		expect(settled).toBe(true);
		expect(await credentials.read("test-oauth")).toEqual(expired);
	});

	it("allows a 16000 ms refresh with a 30000 ms limit and persists its rotated credential", async () => {
		const { models, credentials, rotated, refresh } = await oauthRefreshFixture(30_000);
		const pending = models.getAuth("test-oauth");

		await vi.advanceTimersByTimeAsync(16_000);

		expect(await pending).toEqual({ auth: { apiKey: "new-access" }, source: "OAuth" });
		expect(await credentials.read("test-oauth")).toEqual(rotated);
		expect((await models.getAuth("test-oauth"))?.auth.apiKey).toBe("new-access");
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("captures independent limits instead of retaining the mutable constructor options", async () => {
		const short = await oauthRefreshFixture(1_000);
		const long = await oauthRefreshFixture(30_000);
		short.options.oauthRefreshTimeoutMs = 30_000;
		long.options.oauthRefreshTimeoutMs = 1_000;
		const shortPending = short.models.getAuth("test-oauth");
		const longPending = long.models.getAuth("test-oauth");
		const rejection = expect(shortPending).rejects.toMatchObject({ code: "oauth", cause: { name: "TimeoutError" } });

		await vi.advanceTimersByTimeAsync(1_000);
		await rejection;
		expect(await short.credentials.read("test-oauth")).toEqual(short.expired);
		expect(await long.credentials.read("test-oauth")).toEqual(long.expired);
		await vi.advanceTimersByTimeAsync(15_000);
		expect((await longPending)?.auth.apiKey).toBe("new-access");
		expect(await long.credentials.read("test-oauth")).toEqual(long.rotated);
	});

	it("returns promptly on caller cancellation but persists the configured refresh before releasing the lock", async () => {
		const { models, credentials, expired, rotated, refresh } = await oauthRefreshFixture(30_000);
		const controller = new AbortController();
		const pending = models.getAuth("test-oauth", { signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledOnce();
		const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejection;
		expect(await credentials.read("test-oauth")).toEqual(expired);

		let lockReleased = false;
		const nextMutation = credentials.modify("test-oauth", async (current) => {
			lockReleased = true;
			expect(current).toEqual(rotated);
			return undefined;
		});
		await vi.advanceTimersByTimeAsync(15_999);
		expect(lockReleased).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await nextMutation;
		expect(lockReleased).toBe(true);
		expect(await credentials.read("test-oauth")).toEqual(rotated);
		expect((await models.getAuth("test-oauth"))?.auth.apiKey).toBe("new-access");
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("never starts a provider refresh when the caller aborts while waiting for the credential lock", async () => {
		const { models, credentials, expired, rotated, refresh } = await oauthRefreshFixture(30_000);
		let releaseLock: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const firstMutation = credentials.modify("test-oauth", async () => {
			await held;
			return undefined;
		});
		const modify = vi.spyOn(credentials, "modify");
		const controller = new AbortController();
		const pending = models.getAuth("test-oauth", { signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(modify).toHaveBeenCalledOnce();
		const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejection;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(refresh).not.toHaveBeenCalled();
		releaseLock?.();
		await firstMutation;
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).not.toHaveBeenCalled();
		expect(await credentials.read("test-oauth")).toEqual(expired);

		const next = models.getAuth("test-oauth");
		await vi.advanceTimersByTimeAsync(16_000);
		expect((await next)?.auth.apiKey).toBe("new-access");
		expect(await credentials.read("test-oauth")).toEqual(rotated);
		expect(refresh).toHaveBeenCalledOnce();
	});

	it.each([null, 0, -1, 0.5, "60000", "disabled", Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"rejects oauthRefreshTimeoutMs=%s before touching credential storage",
		(value) => {
			const credentials = new InMemoryCredentialStore();
			const read = vi.spyOn(credentials, "read");
			const list = vi.spyOn(credentials, "list");
			const modify = vi.spyOn(credentials, "modify");
			const remove = vi.spyOn(credentials, "delete");

			expect(() => createModels({ credentials, oauthRefreshTimeoutMs: value as number })).toThrow(
				new RangeError("Invalid oauthRefreshTimeoutMs: expected an integer from 1 to 2147483647 milliseconds"),
			);
			expect(read).not.toHaveBeenCalled();
			expect(list).not.toHaveBeenCalled();
			expect(modify).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
		},
	);

	it.each([1, 2_147_483_647])("accepts the oauthRefreshTimeoutMs boundary %i", async (timeout) => {
		const { models, credentials, expired, rotated } = await oauthRefreshFixture(timeout);
		const pending = models.getAuth("test-oauth");
		if (timeout === 1) {
			const rejection = expect(pending).rejects.toMatchObject({ code: "oauth", cause: { name: "TimeoutError" } });
			await vi.advanceTimersByTimeAsync(1);
			await rejection;
			expect(await credentials.read("test-oauth")).toEqual(expired);
		} else {
			await vi.advanceTimersByTimeAsync(16_000);
			expect((await pending)?.auth.apiKey).toBe("new-access");
			expect(await credentials.read("test-oauth")).toEqual(rotated);
		}
	});
});
