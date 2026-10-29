import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthCommandError, isAuthCommandHelp, parseAuthCommand } from "../src/cli/auth-command.ts";
import { resolveCredentialForPrint } from "../src/cli/credential-print.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { main } from "../src/main.ts";

async function createRuntime(credentials: AuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

describe("credential print commands", () => {
	test("prints a resolved API key", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-api-key" } }));
		const args = parseArgs(["--provider", "openai"]);

		await expect(resolveCredentialForPrint(args, runtime, "api_key")).resolves.toBe("test-api-key");
	});

	test("resolves --model without --provider only among catalog models of configured providers", async () => {
		const runtime = await createRuntime(
			AuthStorage.inMemory({
				openai: { type: "api_key", key: "openai-test-key" },
				anthropic: { type: "api_key", key: "anthropic-test-key" },
			}),
		);

		// anthropic has no gpt-5.5; an uncatalogued id on a configured provider must not count as a match.
		await expect(resolveCredentialForPrint(parseArgs(["--model", "gpt-5.5"]), runtime, "api_key")).resolves.toBe(
			"openai-test-key",
		);
	});

	test("prints bearer tokens resolved from an Authorization header", async () => {
		const runtime = await createRuntime(
			AuthStorage.inMemory({
				"kimi-coding": {
					type: "oauth",
					access: "header-test-token",
					refresh: "test-refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
		);
		const args = parseArgs(["--provider", "kimi-coding"]);

		await expect(resolveCredentialForPrint(args, runtime, "bearer_token")).resolves.toBe("header-test-token");
	});

	test("refreshes an expired OAuth token before printing it", async () => {
		const storage = AuthStorage.inMemory({
			"openai-codex": {
				type: "oauth",
				access: "old-test-token",
				refresh: "test-refresh-token",
				expires: 0,
			},
		});
		const runtime = await createRuntime(storage);
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "fresh-test-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		}));
		const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		oauth.refresh = refresh;
		const args = parseArgs(["--provider", "openai-codex"]);

		await expect(resolveCredentialForPrint(args, runtime, "bearer_token")).resolves.toBe("fresh-test-token");
		expect(refresh).toHaveBeenCalledOnce();
		expect(await storage.read("openai-codex")).toMatchObject({ access: "fresh-test-token" });
	});

	// Regression: https://github.com/earendil-works/pi/issues/11549
	test.each([
		{ name: "short", settings: { oauthRefreshTimeoutMs: 1, githubCopilotModelsTimeoutMs: 1 } },
		{ name: "invalid", settings: { oauthRefreshTimeoutMs: null, githubCopilotModelsTimeoutMs: 0 } },
	])("uses global print deadlines and ignores $name untrusted project settings", async ({ settings }) => {
		const originalCwd = process.cwd();
		const originalEnv = process.env;
		const originalExitCode = process.exitCode;
		const directory = mkdtempSync(join(tmpdir(), "pi-credential-print-deadlines-"));
		const agentDir = join(directory, "agent");
		const projectDir = join(directory, "project");
		const authPath = join(agentDir, "auth.json");
		const accessToken = "synthetic-cli-access-token";
		const expiredCredential = {
			type: "oauth",
			access: "synthetic-cli-expired-token",
			refresh: "synthetic-cli-refresh-token",
			expires: 0,
		};
		let command: Promise<void> | undefined;
		try {
			mkdirSync(agentDir);
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			writeFileSync(authPath, JSON.stringify({ "github-copilot": expiredCredential }));
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ oauthRefreshTimeoutMs: 30_000, githubCopilotModelsTimeoutMs: 60_000 }),
			);
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(settings));
			process.env = { HOME: directory, [ENV_AGENT_DIR]: agentDir };
			process.chdir(projectDir);
			process.exitCode = undefined;
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
			// Keep filesystem lock timestamps on the real clock.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")), milliseconds);
				return controller.signal;
			});
			const modelId = githubCopilotProvider().getModels()[0]?.id;
			if (!modelId) throw new Error("Expected a built-in Copilot model");
			const tokenUrl = "https://api.github.com/copilot_internal/v2/token";
			const catalogUrl = "https://api.individual.githubcopilot.com/models";
			const tokenStarted = Promise.withResolvers<void>();
			const catalogStarted = Promise.withResolvers<void>();
			const requests: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					const url = input instanceof Request ? input.url : String(input);
					requests.push(url);
					let body: unknown;
					let delayMs: number;
					if (url === tokenUrl) {
						tokenStarted.resolve();
						body = { token: accessToken, expires_at: 9999999999 };
						delayMs = 10_000;
					} else if (url === catalogUrl) {
						catalogStarted.resolve();
						body = {
							data: [
								{
									id: modelId,
									model_picker_enabled: true,
									policy: { state: "enabled" },
									capabilities: { supports: { tool_calls: true } },
								},
							],
						};
						delayMs = 6000;
					} else {
						return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
					}
					const signal = init?.signal;
					if (!signal) return Promise.reject(new Error("Expected an OAuth-owned request signal"));
					signal.throwIfAborted();
					return new Promise((resolve, reject) => {
						const abort = () => {
							clearTimeout(timer);
							reject(signal.reason);
						};
						const timer = setTimeout(() => {
							signal.removeEventListener("abort", abort);
							resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
						}, delayMs);
						signal.addEventListener("abort", abort, { once: true });
					});
				}),
			);

			let settled = false;
			command = main(["auth", "print-bearer-token", "--provider", "github-copilot"]).then(() => {
				settled = true;
			});
			await Promise.race([tokenStarted.promise, command]);
			expect(requests).toEqual([tokenUrl]);
			await vi.advanceTimersByTimeAsync(10_000);
			await Promise.race([catalogStarted.promise, command]);
			expect(requests).toEqual([tokenUrl, catalogUrl]);
			await vi.advanceTimersByTimeAsync(5000);
			expect(settled).toBe(false);
			expect(stdout).not.toHaveBeenCalled();
			expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({ "github-copilot": expiredCredential });
			await vi.advanceTimersByTimeAsync(999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await command;

			expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(`${accessToken}\n`);
			expect(stderr).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
			expect(requests).toEqual([tokenUrl, catalogUrl]);
			expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
				"github-copilot": {
					...expiredCredential,
					access: accessToken,
					expires: 9999999999 * 1000 - 5 * 60_000,
					availableModelIds: [modelId],
				},
			});
		} finally {
			try {
				if (vi.isFakeTimers()) await vi.runAllTimersAsync();
				await command;
			} finally {
				vi.restoreAllMocks();
				vi.unstubAllGlobals();
				vi.useRealTimers();
				process.env = originalEnv;
				process.chdir(originalCwd);
				process.exitCode = originalExitCode;
				rmSync(directory, { recursive: true, force: true });
			}
		}
	});

	test("reports unknown auth options like package commands", async () => {
		const originalExitCode = process.exitCode;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			process.exitCode = undefined;
			await main(["auth", "check", "--provider", "openai-codex", "--credentails"]);
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --credentails for "auth check".');
			expect(stderr).toContain(
				'Use "pi --help" or "pi auth check --provider <provider> [--json] [--credentials] [--no-refresh]".',
			);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			errorSpy.mockRestore();
		}
	});

	test("parses credential commands and rejects invalid arguments or credential types", async () => {
		const runtime = await createRuntime(
			AuthStorage.inMemory({
				"openai-codex": {
					type: "oauth",
					access: "test-token-not-to-be-printed",
					refresh: "test-refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
		);

		expect(parseAuthCommand(["auth", "print-api-key", "--provider", "openai"])).toEqual({
			kind: "api_key",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(parseAuthCommand(["auth", "print-bearer-token"])).toMatchObject({ kind: "bearer_token" });
		expect(parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", "30m"])).toEqual({
			kind: "bearer_token",
			args: [],
			json: false,
			credentials: false,
			noRefresh: false,
			minExpiryMs: 30 * 60_000,
		});
		expect(() => parseAuthCommand(["auth", "print-api-key", "--min-expiry", "30m"])).toThrow(
			"only supported by print-bearer-token",
		);
		expect(isAuthCommandHelp(["auth", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "print-api-key", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "print-bearer-token", "-h"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "check", "--help"])).toBe(true);
		expect(() => parseAuthCommand(["auth", "unknown"])).toThrow(AuthCommandError);
		await expect(resolveCredentialForPrint(parseArgs([]), runtime, "api_key")).rejects.toThrow(
			"requires --provider <provider> or --model <model>",
		);
		await expect(
			resolveCredentialForPrint(parseArgs(["--provider", "openai-codex"]), runtime, "api_key"),
		).rejects.toThrow("configured with OAuth");
	});
});
