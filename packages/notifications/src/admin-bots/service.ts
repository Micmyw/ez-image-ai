import {
	claimAdminBotReceipt,
	completeAdminBotReceipt,
	getPaymentBotData,
	getSupportBotIdentity,
	type PaymentBotReference,
	type Prisma,
} from "@repo/database";

import { sendBotChannels } from "./channels";
import { mergeBotConfiguration, readBotConfiguration } from "./configuration";
import {
	assertPlatformBotScope,
	type BotChannel,
	type BotConfiguration,
	type BotEnvelope,
	type BotEvent,
	type BotScope,
} from "./types";

const defaults = {
	en: {
		payment:
			"[EzPic] Payment received\n{{charge_type}} · {{plan}}\n{{amount}}\nOrder: {{order_no}}\nUser: {{user}}\nPaid: {{paid_at}}\nSource: {{utm_source}}\nCampaign: {{utm_campaign}}\n{{admin_url}}",
		ticket:
			"[EzPic] {{event}}\n{{title}}\n{{content}}\nUser: {{user}}\nTime: {{created_at}}\n{{admin_url}}",
	},
	zh: {
		payment:
			"【EzPic】收款成功\n{{charge_type}} · {{plan}}\n{{amount}}\n订单：{{order_no}}\n用户：{{user}}\n支付：{{paid_at}}\n来源：{{utm_source}}\n广告系列：{{utm_campaign}}\n{{admin_url}}",
		ticket:
			"【EzPic】{{event}}\n{{title}}\n{{content}}\n用户：{{user}}\n时间：{{created_at}}\n{{admin_url}}",
	},
};

export function renderBotTemplate(template: string, data: Record<string, string>) {
	// Values are substituted once, never interpreted as template syntax or code.
	return template
		.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => data[key] || "-")
		.slice(0, 4000);
}
function formattedTime(value: string, config: BotConfiguration) {
	return new Intl.DateTimeFormat(config.language === "zh" ? "zh-CN" : "en-GB", {
		timeZone: config.timeZone,
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
function adminUrl(route: string) {
	const base = process.env.NEXT_PUBLIC_SAAS_URL;
	if (!base) return "";
	try {
		const url = new URL(route, base);
		return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
	} catch {
		return "";
	}
}
function chargeLabel(value: string, language: "en" | "zh") {
	const labels: Record<string, [string, string]> = {
		"one-time": ["One-time payment", "一次性付款"],
		first: ["First subscription charge", "首次订阅扣款"],
		renewal: ["Subscription renewal", "订阅续费"],
		subscription: ["Subscription payment", "订阅付款"],
	};
	return labels[value]?.[language === "zh" ? 1 : 0] ?? value;
}
function money(micros: string, currency: string) {
	const amount = BigInt(micros);
	const fraction = (amount % 1_000_000n)
		.toString()
		.padStart(6, "0")
		.replace(/0+$/, "")
		.padEnd(2, "0");
	return `${currency.toUpperCase()} ${amount / 1_000_000n}.${fraction}`;
}
function attributionData(value: unknown): Record<string, string> {
	const outer =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const data =
		outer.registration &&
		typeof outer.registration === "object" &&
		!Array.isArray(outer.registration)
			? (outer.registration as Record<string, unknown>)
			: outer;
	return Object.fromEntries(
		[
			["utm_source", "utmSource"],
			["utm_medium", "utmMedium"],
			["utm_campaign", "utmCampaign"],
			["utm_term", "utmTerm"],
			["utm_content", "utmContent"],
			["referrer", "referrerOrigin"],
			["country", "country"],
		].map(([output, key]) => {
			let value =
				typeof data[key!] === "string"
					? String(data[key!])
							.replace(/[\r\n]/g, " ")
							.slice(0, 200)
					: "";
			if (output === "referrer" && value) {
				try {
					value = new URL(value).origin;
				} catch {
					value = "";
				}
			}
			return [output, value];
		}),
	);
}
function envelope(
	config: BotConfiguration,
	event: BotEvent,
	data: Record<string, string>,
	test = false,
): BotEnvelope {
	const category = event === "payment.succeeded" ? "payment" : "ticket";
	const text = renderBotTemplate(
		config.templates[category] || defaults[config.language][category],
		data,
	);
	return {
		event,
		test,
		text: `${test ? "[Test] " : ""}${text}`,
		data,
		sent_at: new Date().toISOString(),
	};
}

async function deliverOnce(config: BotConfiguration, eventKey: string, body: BotEnvelope) {
	if (!(await claimAdminBotReceipt({ eventKey, event: body.event }))) return;
	const results = await sendBotChannels(config, body);
	await completeAdminBotReceipt({ eventKey, results: results as unknown as Prisma.InputJsonValue });
	if (results.some((result) => !result.success))
		console.warn("Admin bot channel delivery failed", { eventKey, results });
}
function logFailure(error: unknown) {
	const message = error instanceof Error ? error.message : "";
	console.warn("Admin bot notification unavailable", {
		reason: /^ADMIN_BOT_[A-Z0-9_]+$/.test(message) ? message : "ADMIN_BOT_INTERNAL_FAILURE",
	});
}

/** Best effort after a successful settlement commit. Never rejects into payment processing. */
export async function notifyAdminPaymentSuccess(input: PaymentBotReference): Promise<void> {
	try {
		const { configuration: config } = await readBotConfiguration();
		if (!config.paymentEnabled) return;
		const paid = await getPaymentBotData(input);
		if (!paid) return;
		const data = {
			order_no: paid.orderId,
			provider_payment_id: paid.providerPaymentId,
			provider: paid.provider,
			amount_micros: paid.amountMicros,
			currency: paid.currency,
			amount: money(paid.amountMicros, paid.currency),
			charge_type: chargeLabel(paid.chargeType, config.language),
			payment_type: paid.chargeType,
			plan: paid.plan,
			user: paid.user ? `${paid.user.name} <${paid.user.email}>` : "",
			email: paid.user?.email ?? "",
			paid_at: formattedTime(paid.paidAt, config),
			paid_at_iso: paid.paidAt,
			admin_url: adminUrl(`/admin/payments?reference=${encodeURIComponent(paid.orderId)}`),
			...attributionData(paid.user?.registrationAttribution ?? paid.attribution),
		};
		await deliverOnce(config, paid.eventKey, envelope(config, "payment.succeeded", data));
	} catch (error) {
		logFailure(error);
	}
}

export async function notifyAdminTicketEvent(input: {
	event: Exclude<BotEvent, "payment.succeeded">;
	ticket: { id: string; createdByUserId: string; subject: string };
	messageId: string;
	body: string;
	createdAt: string;
}): Promise<void> {
	try {
		const { configuration: config } = await readBotConfiguration();
		if (!config.ticketEnabled) return;
		const user = await getSupportBotIdentity(input.ticket.createdByUserId);
		const data = {
			event: input.event,
			ticket_id: input.ticket.id,
			message_id: input.messageId,
			title: input.ticket.subject,
			content: input.body.slice(0, 500),
			user: user ? `${user.name} <${user.email}>` : "",
			email: user?.email ?? "",
			created_at: formattedTime(input.createdAt, config),
			admin_url: adminUrl(`/admin/support?ticketId=${encodeURIComponent(input.ticket.id)}`),
		};
		await deliverOnce(config, `ticket:${input.messageId}`, envelope(config, input.event, data));
	} catch (error) {
		logFailure(error);
	}
}

export async function testAdminBotConfiguration(
	scope: BotScope,
	input: {
		configuration?: BotConfiguration;
		channel?: BotChannel;
		event?: "payment" | "ticket";
	},
) {
	assertPlatformBotScope(scope);
	const saved = await readBotConfiguration();
	const config = input.configuration
		? mergeBotConfiguration(saved.configuration, input.configuration)
		: saved.configuration;
	const now = new Date().toISOString();
	const data = {
		order_no: "TEST-ORDER",
		provider: "mock",
		provider_payment_id: "TEST-PAYMENT",
		amount_micros: "29000000",
		currency: "USD",
		amount: "USD 29.00",
		charge_type: chargeLabel("renewal", config.language),
		payment_type: "renewal",
		plan: "Test plan",
		user: "Test Buyer <buyer@example.com>",
		email: "buyer@example.com",
		paid_at: formattedTime(now, config),
		paid_at_iso: now,
		utm_source: "test",
		utm_campaign: "test",
		ticket_id: "TEST-TICKET",
		message_id: "TEST-MESSAGE",
		title: "Test ticket",
		content: "Sample support message.",
		created_at: formattedTime(now, config),
		event: "ticket.created",
		admin_url: "",
	};
	const body = envelope(
		config,
		input.event === "ticket" ? "ticket.created" : "payment.succeeded",
		data,
		true,
	);
	const results = await sendBotChannels(config, body, { channel: input.channel });
	return { results, test: true as const };
}
