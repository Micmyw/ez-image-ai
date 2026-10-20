import { postBotJson } from "#admin-bot-transport";

import {
	BOT_CHANNELS,
	type BotChannel,
	type BotConfiguration,
	type BotEnvelope,
	type BotPostJson,
	type BotResult,
} from "./types";
import { validateBotUrl } from "./url-policy";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

async function signature(secret: string, timestamp: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(`${timestamp}\n${secret}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = await crypto.subtle.sign("HMAC", key, new Uint8Array());
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function sendChannel(
	channel: BotChannel,
	config: BotConfiguration,
	envelope: BotEnvelope,
	post: BotPostJson,
) {
	switch (channel) {
		case "telegram": {
			const { apiBase, botToken, chatId } = config.channels.telegram;
			if (!botToken || !chatId) throw new Error("ADMIN_BOT_CHANNEL_INCOMPLETE");
			const url = validateBotUrl(apiBase, channel);
			if (url.search || url.pathname !== "/") throw new Error("ADMIN_BOT_TELEGRAM_BASE_INVALID");
			if (!/^[A-Za-z0-9:_-]+$/.test(botToken)) throw new Error("ADMIN_BOT_TOKEN_INVALID");
			url.pathname = `/bot${botToken}/sendMessage`;
			const response = record(
				await post(
					url,
					{ chat_id: chatId, text: envelope.text, disable_web_page_preview: true },
					{},
				),
			);
			if (response.ok === false) throw new Error("ADMIN_BOT_PROVIDER_REJECTED");
			return;
		}
		case "feishu": {
			const { webhookUrl, secret } = config.channels.feishu;
			const timestamp = Math.floor(Date.parse(envelope.sent_at) / 1000).toString();
			const body = {
				msg_type: "text",
				content: { text: envelope.text },
				...(secret ? { timestamp, sign: await signature(secret, timestamp) } : {}),
			};
			const response = record(await post(validateBotUrl(webhookUrl, channel), body, {}));
			if ((response.code ?? response.StatusCode ?? 0) !== 0)
				throw new Error("ADMIN_BOT_PROVIDER_REJECTED");
			return;
		}
		case "wecom": {
			const response = record(
				await post(
					validateBotUrl(config.channels.wecom.webhookUrl, channel),
					{
						msgtype: "text",
						text: { content: envelope.text },
					},
					{},
				),
			);
			if ((response.errcode ?? 0) !== 0) throw new Error("ADMIN_BOT_PROVIDER_REJECTED");
			return;
		}
		case "webhook": {
			const { url, token } = config.channels.webhook;
			await post(
				validateBotUrl(url, channel),
				envelope,
				token ? { Authorization: `Bearer ${token}` } : {},
			);
		}
	}
}

export async function sendBotChannels(
	config: BotConfiguration,
	envelope: BotEnvelope,
	options: { channel?: BotChannel; post?: BotPostJson } = {},
): Promise<BotResult[]> {
	return Promise.all(
		BOT_CHANNELS.filter(
			(channel) =>
				(!options.channel || options.channel === channel) && config.channels[channel].enabled,
		).map(async (channel) => {
			try {
				await sendChannel(channel, config, envelope, options.post ?? postBotJson);
				return { channel, success: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				return {
					channel,
					success: false,
					// Provider response bodies/URLs can contain credentials or private data.
					error: /^ADMIN_BOT_[A-Z0-9_]+$/.test(message) ? message : "ADMIN_BOT_DELIVERY_FAILED",
				};
			}
		}),
	);
}
