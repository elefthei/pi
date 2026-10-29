import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { validateTimeoutMs } from "../utils/abort.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

export interface GitHubCopilotProviderOptions {
	/** Deadline for catalog requests, including response bodies; defaults to five seconds. */
	modelCatalogTimeoutMs?: number;
}

export function githubCopilotProvider(
	options?: GitHubCopilotProviderOptions,
): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	const modelCatalogTimeoutMs =
		options?.modelCatalogTimeoutMs === undefined
			? 5_000
			: validateTimeoutMs(options.modelCatalogTimeoutMs, "modelCatalogTimeoutMs");
	return createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({
				name: "GitHub Copilot",
				isSubscription: true,
				load: () => loadGitHubCopilotOAuth(modelCatalogTimeoutMs),
			}),
		},
		models: Object.values(GITHUB_COPILOT_MODELS),
		filterModels: (models, credential) => {
			if (credential?.type !== "oauth") return models;
			const availableModelIds = credential.availableModelIds;
			if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
				return models;
			}
			const available = new Set(availableModelIds);
			return models.filter((model) => available.has(model.id));
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
