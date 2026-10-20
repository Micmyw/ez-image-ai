export type BotChannel = "telegram" | "feishu" | "wecom" | "webhook";
export type BotEvent =
	| "payment.succeeded"
	| "ticket.created"
	| "ticket.customer_replied"
	| "ticket.admin_replied";
export type BotScope =
	| { kind: "platform" }
	| { kind: "organization"; organizationId: string }
	| { kind: "user"; userId: string };

export interface BotConfiguration {
	paymentEnabled: boolean;
	ticketEnabled: boolean;
	language: "en" | "zh";
	timeZone: string;
	templates: { payment: string; ticket: string };
	channels: {
		telegram: { enabled: boolean; apiBase: string; chatId: string; botToken: string };
		feishu: { enabled: boolean; webhookUrl: string; secret: string };
		wecom: { enabled: boolean; webhookUrl: string };
		webhook: { enabled: boolean; url: string; token: string };
	};
}
export interface BotResult {
	channel: BotChannel;
	success: boolean;
	error?: string;
}
export interface BotEnvelope {
	event: BotEvent;
	test: boolean;
	text: string;
	data: Record<string, string>;
	sent_at: string;
}
export type BotPostJson = (
	url: URL,
	body: unknown,
	headers: Record<string, string>,
) => Promise<unknown>;

/** Configuration and policy rejections before any network or persistent write. */
export class AdminBotInputError extends Error {
	constructor(
		readonly code: string,
		readonly status: 400 | 403 | 409 = 400,
	) {
		super(code);
	}
}

export const BOT_SECRET_MASK = "••••••••";
export const BOT_CHANNELS: readonly BotChannel[] = ["telegram", "feishu", "wecom", "webhook"];
export const DEFAULT_BOT_CONFIGURATION: BotConfiguration = {
	paymentEnabled: false,
	ticketEnabled: false,
	language: "en",
	timeZone: "UTC",
	templates: { payment: "", ticket: "" },
	channels: {
		telegram: { enabled: false, apiBase: "https://api.telegram.org", chatId: "", botToken: "" },
		feishu: { enabled: false, webhookUrl: "", secret: "" },
		wecom: { enabled: false, webhookUrl: "" },
		webhook: { enabled: false, url: "", token: "" },
	},
};

export function assertPlatformBotScope(scope: BotScope) {
	if (scope.kind !== "platform") throw new AdminBotInputError("ADMIN_BOT_FORBIDDEN", 403);
}
