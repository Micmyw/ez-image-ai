import type { botConfigurationSchema } from "@repo/api/modules/support/types";
import type { z } from "zod";

type Configuration = z.infer<typeof botConfigurationSchema>;
const MASK = "••••••••";

/** Masked credentials may only be retained with the endpoint they were saved against. */
export function notificationDraftForSubmission(original: Configuration, draft: Configuration) {
	const configuration = structuredClone(draft);
	const invalid: Array<"telegram" | "feishu" | "webhook"> = [];
	if (
		configuration.channels.telegram.apiBase !== original.channels.telegram.apiBase &&
		configuration.channels.telegram.botToken === MASK
	) {
		configuration.channels.telegram.botToken = "";
		invalid.push("telegram");
	}
	if (
		configuration.channels.feishu.webhookUrl !== original.channels.feishu.webhookUrl &&
		configuration.channels.feishu.secret === MASK
	) {
		configuration.channels.feishu.secret = "";
		invalid.push("feishu");
	}
	if (
		configuration.channels.webhook.url !== original.channels.webhook.url &&
		configuration.channels.webhook.token === MASK
	) {
		configuration.channels.webhook.token = "";
		invalid.push("webhook");
	}
	return { configuration, invalid };
}
