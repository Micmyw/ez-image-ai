import { getAdminBotConfigRow, saveAdminBotConfigRow, type Prisma } from "@repo/database";

import { decryptBotSecrets, encryptBotSecrets, hasBotEncryptionKey } from "./crypto";
import {
	AdminBotInputError,
	assertPlatformBotScope,
	BOT_SECRET_MASK,
	DEFAULT_BOT_CONFIGURATION,
	type BotConfiguration,
	type BotScope,
} from "./types";
import { validateBotUrl } from "./url-policy";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AdminBotInputError("ADMIN_BOT_CONFIG_INVALID");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096) {
	if (typeof value !== "string" || value.length > max || value.includes("\0"))
		throw new AdminBotInputError("ADMIN_BOT_CONFIG_INVALID");
	return value;
}
function bool(value: unknown) {
	if (typeof value !== "boolean") throw new AdminBotInputError("ADMIN_BOT_CONFIG_INVALID");
	return value;
}
export function parseBotConfiguration(value: unknown): BotConfiguration {
	const root = object(value);
	const channels = object(root.channels);
	const telegram = object(channels.telegram);
	const feishu = object(channels.feishu);
	const wecom = object(channels.wecom);
	const webhook = object(channels.webhook);
	const templates = object(root.templates);
	if (root.language !== "en" && root.language !== "zh")
		throw new AdminBotInputError("ADMIN_BOT_LANGUAGE_INVALID");
	const timeZone = text(root.timeZone, 100);
	try {
		new Intl.DateTimeFormat("en", { timeZone }).format();
	} catch {
		throw new AdminBotInputError("ADMIN_BOT_TIMEZONE_INVALID");
	}
	return {
		paymentEnabled: bool(root.paymentEnabled),
		ticketEnabled: bool(root.ticketEnabled),
		language: root.language,
		timeZone,
		templates: { payment: text(templates.payment, 3000), ticket: text(templates.ticket, 3000) },
		channels: {
			telegram: {
				enabled: bool(telegram.enabled),
				apiBase: text(telegram.apiBase, 2048).trim(),
				chatId: text(telegram.chatId, 200).trim(),
				botToken: text(telegram.botToken).trim(),
			},
			feishu: {
				enabled: bool(feishu.enabled),
				webhookUrl: text(feishu.webhookUrl).trim(),
				secret: text(feishu.secret).trim(),
			},
			wecom: { enabled: bool(wecom.enabled), webhookUrl: text(wecom.webhookUrl).trim() },
			webhook: {
				enabled: bool(webhook.enabled),
				url: text(webhook.url).trim(),
				token: text(webhook.token).trim(),
			},
		},
	};
}

type Secrets = {
	telegram: string;
	feishuUrl: string;
	feishuSecret: string;
	wecomUrl: string;
	webhookUrl: string;
	webhookToken: string;
};
function extractSecrets(config: BotConfiguration): Secrets {
	return {
		telegram: config.channels.telegram.botToken,
		feishuUrl: config.channels.feishu.webhookUrl,
		feishuSecret: config.channels.feishu.secret,
		wecomUrl: config.channels.wecom.webhookUrl,
		webhookUrl: config.channels.webhook.url,
		webhookToken: config.channels.webhook.token,
	};
}
function withSecrets(config: BotConfiguration, secrets: Secrets): BotConfiguration {
	const result = structuredClone(config);
	result.channels.telegram.botToken = secrets.telegram;
	result.channels.feishu.webhookUrl = secrets.feishuUrl;
	result.channels.feishu.secret = secrets.feishuSecret;
	result.channels.wecom.webhookUrl = secrets.wecomUrl;
	result.channels.webhook.url = secrets.webhookUrl;
	result.channels.webhook.token = secrets.webhookToken;
	return result;
}
export function maskBotConfiguration(config: BotConfiguration): BotConfiguration {
	return withSecrets(
		config,
		Object.fromEntries(
			Object.entries(extractSecrets(config)).map(([key, value]) => [
				key,
				value ? BOT_SECRET_MASK : "",
			]),
		) as Secrets,
	);
}
function normalizeEndpoint(value: string) {
	// URL serialization equates an empty origin path with "/", but preserves
	// meaningful /hook vs /hook/ and query changes at external receivers.
	if (!value) return "";
	try {
		return new URL(value).toString();
	} catch {
		throw new AdminBotInputError("ADMIN_BOT_URL_INVALID");
	}
}

/** Masked fields mean keep; changing an endpoint requires explicit secret re-entry or clearing. */
export function mergeBotConfiguration(
	saved: BotConfiguration,
	incoming: unknown,
): BotConfiguration {
	const next = parseBotConfiguration(incoming);
	const before = extractSecrets(saved);
	const supplied = extractSecrets(next);
	const secrets = { ...supplied };
	for (const key of Object.keys(secrets) as Array<keyof Secrets>)
		if (supplied[key] === BOT_SECRET_MASK) secrets[key] = before[key];
	const pairs: Array<[string, string, keyof Secrets]> = [
		[saved.channels.telegram.apiBase, next.channels.telegram.apiBase, "telegram"],
		[before.webhookUrl, secrets.webhookUrl, "webhookToken"],
		[before.feishuUrl, secrets.feishuUrl, "feishuSecret"],
	];
	for (const [oldEndpoint, newEndpoint, secret] of pairs)
		if (
			normalizeEndpoint(oldEndpoint) !== normalizeEndpoint(newEndpoint) &&
			before[secret] &&
			supplied[secret] === BOT_SECRET_MASK
		)
			throw new AdminBotInputError("ADMIN_BOT_ENDPOINT_SECRET_REQUIRED");
	const result = withSecrets(next, secrets);
	for (const [channel, value] of [
		["telegram", result.channels.telegram.apiBase],
		["feishu", secrets.feishuUrl],
		["wecom", secrets.wecomUrl],
		["webhook", secrets.webhookUrl],
	] as const)
		if (value) validateBotUrl(value, channel);
	if (result.channels.telegram.enabled && (!secrets.telegram || !result.channels.telegram.chatId))
		throw new AdminBotInputError("ADMIN_BOT_CHANNEL_INCOMPLETE");
	if (result.channels.feishu.enabled && !secrets.feishuUrl)
		throw new AdminBotInputError("ADMIN_BOT_CHANNEL_INCOMPLETE");
	if (result.channels.wecom.enabled && !secrets.wecomUrl)
		throw new AdminBotInputError("ADMIN_BOT_CHANNEL_INCOMPLETE");
	if (result.channels.webhook.enabled && !secrets.webhookUrl)
		throw new AdminBotInputError("ADMIN_BOT_CHANNEL_INCOMPLETE");
	if (/[\r\n]/.test(secrets.webhookToken)) throw new AdminBotInputError("ADMIN_BOT_TOKEN_INVALID");
	return result;
}

export async function readBotConfiguration() {
	const row = await getAdminBotConfigRow();
	if (!row) return { version: 0, configuration: structuredClone(DEFAULT_BOT_CONFIGURATION) };
	const config = parseBotConfiguration(row.payload);
	const encrypted = row.encryptedSecrets
		? object(await decryptBotSecrets(row.encryptedSecrets))
		: {};
	const secrets = Object.fromEntries(
		Object.keys(extractSecrets(config)).map((key) => [key, text(encrypted[key] ?? "")]),
	) as Secrets;
	return { version: row.version, configuration: withSecrets(config, secrets) };
}

export async function getAdminBotConfiguration(scope: BotScope) {
	assertPlatformBotScope(scope);
	const saved = await readBotConfiguration();
	return {
		...saved,
		configuration: maskBotConfiguration(saved.configuration),
		encryptionReady: hasBotEncryptionKey(),
		deliveryMode: "best_effort" as const,
	};
}

export async function updateAdminBotConfiguration(
	scope: BotScope,
	input: { expectedVersion: number; configuration: BotConfiguration },
	actorId: string,
) {
	assertPlatformBotScope(scope);
	const saved = await readBotConfiguration();
	if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== saved.version)
		throw new AdminBotInputError("ADMIN_BOT_CONFIG_CONFLICT", 409);
	const configuration = mergeBotConfiguration(saved.configuration, input.configuration);
	const secrets = extractSecrets(configuration);
	const encryptedSecrets = Object.values(secrets).some(Boolean)
		? await encryptBotSecrets(secrets)
		: null;
	const payload = withSecrets(
		configuration,
		Object.fromEntries(Object.keys(secrets).map((key) => [key, ""])) as Secrets,
	);
	const version = await saveAdminBotConfigRow({
		expectedVersion: input.expectedVersion,
		payload: payload as unknown as Prisma.InputJsonValue,
		encryptedSecrets,
		updatedBy: actorId,
	}).catch((error: unknown) => {
		if (error instanceof Error && error.message === "ADMIN_BOT_CONFIG_CONFLICT")
			throw new AdminBotInputError("ADMIN_BOT_CONFIG_CONFLICT", 409);
		throw error;
	});
	return {
		version,
		configuration: maskBotConfiguration(configuration),
		encryptionReady: hasBotEncryptionKey(),
		deliveryMode: "best_effort" as const,
	};
}
