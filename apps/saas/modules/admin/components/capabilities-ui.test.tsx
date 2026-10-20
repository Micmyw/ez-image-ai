import type { AdminAnalyticsOverview } from "@repo/api/modules/admin-analytics/types";
import type {
	AdminBillingOrder,
	AdminBillingRefundResult,
} from "@repo/api/modules/admin-billing/schemas";
import type { botConfigurationSchema } from "@repo/api/modules/support/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import de from "../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../../packages/i18n/translations/fr/saas.json";
import { TicketMessages } from "../../support/components/SupportWorkspace";
import {
	createWriteAttempt,
	createWriteCoordinator,
	moneyMicros,
	sourceFilterInput,
} from "../lib/capabilities-client";
import { notificationDraftForSubmission } from "../lib/notification-draft";
import { AnalyticsOverview } from "./AnalyticsDashboard";
import { PaymentsPanel, RefundOutcome } from "./PaymentsPanel";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

function render(children: ReactNode, messages = en, locale = "en") {
	return renderToStaticMarkup(
		<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
			{children}
		</NextIntlClientProvider>,
	);
}

function leaves(value: unknown, prefix = ""): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
			typeof child === "string"
				? [[`${prefix}${key}`, child]]
				: Object.entries(leaves(child, `${prefix}${key}.`)),
		),
	);
}

const coverage = {
	unknownPaymentFacts: 2,
	unknownPaymentDates: 1,
	unknownPaymentUsers: 1,
	unknownRenewalKinds: 1,
	unknownAttributionUsers: 3,
	trialingAvailable: false as const,
	excludedTestPayments: 2,
	unclassifiedPayments: 1,
	unclassifiedRefunds: 1,
	unlinkedCheckoutPayments: 1,
	unclassifiedSubscriptions: 1,
};
const overview: AdminAnalyticsOverview = {
	generatedAt: "2026-10-20T00:00:00.000Z",
	environment: "production",
	users: { total: 10, new24h: 2 },
	revenue30d: [
		{
			currency: "USD",
			grossMicros: "10000000",
			refundedMicros: "1000000",
			netMicros: "9000000",
			orders: 1,
		},
		{
			currency: "CNY",
			grossMicros: "20000000",
			refundedMicros: "0",
			netMicros: "20000000",
			orders: 1,
		},
	],
	revenueBasis: "payments_in_last_30d_less_their_recorded_refunds",
	subscriptions: { active: 2, trialing: null },
	openTickets: 1,
	coverage,
};

describe("admin capability safeguards", () => {
	it("keeps all sources, explicit empty attribution and unknown history distinct", () => {
		expect(sourceFilterInput("all", "ignored")).toBeUndefined();
		expect(sourceFilterInput("empty", "ignored")).toBe("");
		expect(sourceFilterInput("unknown", "ignored")).toBeNull();
		expect(sourceFilterInput("value", " campaign ")).toBe("campaign");
	});

	it("formats exact micros beyond Number safe integers and uses currency precision", () => {
		expect(moneyMicros("9007199254740993120000", "USD")).toBe("$9,007,199,254,740,993.12");
		expect(moneyMicros("-1250000", "USD")).toBe("-$1.25");
		expect(moneyMicros("1500000", "JPY")).toBe("¥2");
		expect(moneyMicros("1000000", "USD", "de")).toContain("1,00");
		expect(moneyMicros(null, "USD")).toBe("—");
	});

	it("freezes the confirmed payload with its request key", () => {
		const draft = { orderNo: "order-1", nested: { cancel: false } };
		const attempt = createWriteAttempt(draft, "fixed-request-key");
		draft.orderNo = "order-2";
		draft.nested.cancel = true;
		expect(attempt).toEqual({
			input: { orderNo: "order-1", nested: { cancel: false } },
			idempotencyKey: "fixed-request-key",
		});
	});

	it("blocks concurrent clicks before React has rendered a disabled button", async () => {
		let finish!: (value: string) => void;
		const execute = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		const coordinator = createWriteCoordinator<{ orderNo: string }, string>();
		const first = coordinator.run({ orderNo: "order-1" }, execute);
		expect(await coordinator.run({ orderNo: "order-1" }, execute)).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
		finish("done");
		expect(await first).toBe("done");
	});

	it("retains the original key and locks writes after an unknown outcome", async () => {
		const coordinator = createWriteCoordinator<{ orderNo: string }, string>();
		const execute = vi.fn(async () => {
			throw { code: "INTERNAL_SERVER_ERROR" };
		});
		await expect(coordinator.run({ orderNo: "order-1" }, execute)).rejects.toEqual({
			code: "INTERNAL_SERVER_ERROR",
		});
		const key = coordinator.attempt?.idempotencyKey;
		expect(key).toBeTruthy();
		expect(coordinator.uncertain).toBe(true);
		expect(await coordinator.run({ orderNo: "order-2" }, execute)).toBeUndefined();
		expect(coordinator.attempt?.idempotencyKey).toBe(key);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("allows correction only after a definite pre-execution rejection", async () => {
		const coordinator = createWriteCoordinator<{ ownerId: string }, string>();
		await expect(
			coordinator.run({ ownerId: "invalid" }, async () => {
				throw { code: "BAD_REQUEST" };
			}),
		).rejects.toEqual({ code: "BAD_REQUEST" });
		expect(coordinator.uncertain).toBe(false);
		expect(coordinator.attempt).toBeNull();
		expect(await coordinator.run({ ownerId: "valid" }, async () => "saved")).toBe("saved");
	});
});

describe("notification endpoint credential binding", () => {
	const config: z.infer<typeof botConfigurationSchema> = {
		paymentEnabled: true,
		ticketEnabled: true,
		language: "en",
		timeZone: "UTC",
		templates: { payment: "", ticket: "" },
		channels: {
			telegram: {
				enabled: true,
				apiBase: "https://api.telegram.org",
				chatId: "chat-1",
				botToken: "••••••••",
			},
			feishu: { enabled: true, webhookUrl: "••••••••", secret: "••••••••" },
			wecom: { enabled: false, webhookUrl: "" },
			webhook: { enabled: true, url: "••••••••", token: "••••••••" },
		},
	};
	it("preserves masks only when their original endpoint is unchanged", () => {
		expect(notificationDraftForSubmission(config, config)).toEqual({
			configuration: config,
			invalid: [],
		});
	});
	it("removes every old masked credential when its destination changes", () => {
		const changed = structuredClone(config);
		changed.channels.telegram.apiBase = "https://new.example.test";
		changed.channels.feishu.webhookUrl = "https://new.example.test/feishu";
		changed.channels.webhook.url = "https://new.example.test/webhook";
		const prepared = notificationDraftForSubmission(config, changed);
		expect(prepared.invalid).toEqual(["telegram", "feishu", "webhook"]);
		expect(prepared.configuration.channels.telegram.botToken).toBe("");
		expect(prepared.configuration.channels.feishu.secret).toBe("");
		expect(prepared.configuration.channels.webhook.token).toBe("");
	});
	it("allows explicit new credentials or explicit clearing at the new destination", () => {
		const changed = structuredClone(config);
		changed.channels.webhook.url = "https://new.example.test/webhook";
		changed.channels.webhook.token = "new-test-token";
		expect(notificationDraftForSubmission(config, changed).invalid).toEqual([]);
		changed.channels.webhook.token = "";
		expect(notificationDraftForSubmission(config, changed).invalid).toEqual([]);
	});
});

describe("admin and customer rendering", () => {
	it.each([
		["en", en],
		["de", de],
	] as const)(
		"renders separate currency rows and unavailable trial data in %s",
		(locale, messages) => {
			const html = render(<AnalyticsOverview data={overview} />, messages, locale);
			expect(html).toContain("USD");
			expect(html).toContain("CNY");
			expect(html).toContain(messages.admin.capabilities.analytics.unavailable);
			expect(html).toContain(messages.admin.capabilities.analytics.overviewBasis);
			expect(html).toContain(messages.admin.capabilities.analytics.unknownAttributionUsers);
		},
	);

	it("shows refund acceptance, recovered credits, debt and cancellation failure separately", () => {
		const result: AdminBillingRefundResult = {
			orderNo: "order-1",
			requestId: "refund-1",
			status: "PROCESSING",
			amountMicros: "10000000",
			currency: "USD",
			credits: { requested: "100", revoked: "60", debtIncurred: "40" },
			cancellation: { policyRequired: true, status: "FAILED", error: "CANCEL_PENDING_REVIEW" },
			error: null,
		};
		const html = render(<RefundOutcome result={result} />);
		for (const text of [
			"PROCESSING",
			"FAILED",
			"CANCEL_PENDING_REVIEW",
			"100",
			"60",
			"40",
			en.admin.capabilities.payments.pendingHint,
			en.admin.capabilities.payments.fundsHint,
		])
			expect(html).toContain(text);
	});

	it("hides refund controls for a read-only operator and for unverified payment facts", () => {
		const order: AdminBillingOrder = {
			orderNo: "order-1",
			productKind: "PLAN",
			ownerType: "USER",
			ownerId: "user-1",
			provider: "paypal",
			amountMicros: "10000000",
			currency: "USD",
			paidAt: "2026-10-20T00:00:00.000Z",
			refundedAmountMicros: "0",
			remainingAmountMicros: "10000000",
			refundRequestId: null,
			refundStatus: null,
			canRefund: true,
			blockedReason: null,
			cancellationPolicyRequired: true,
			hasSubscription: true,
			canCancelSubscription: true,
		};
		for (const [permissions, canRefund] of [
			[["admin.payments.read"], true],
			[["admin.payments.read", "admin.payments.refund"], false],
		] as const) {
			const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			client.setQueryData(["admin-capabilities", "operations"], {
				operations: [],
				permissions,
				scope: { kind: "platform" },
			});
			client.setQueryData(["admin-capabilities", "orders_list", { limit: 30 }], {
				items: [{ ...order, canRefund }],
				nextCursor: null,
			});
			const html = render(
				<QueryClientProvider client={client}>
					<PaymentsPanel />
				</QueryClientProvider>,
			);
			expect(html).toContain("order-1");
			expect(html).not.toContain(en.admin.capabilities.payments.reviewRefund);
			client.clear();
		}
	});

	it("renders customer and administrator messages as escaped text", () => {
		const html = render(
			<TicketMessages
				ticket={{
					id: "ticket-1",
					subject: "Billing help",
					status: "OPEN",
					createdByUserId: "user-1",
					organizationId: null,
					createdAt: "2026-10-20T00:00:00.000Z",
					updatedAt: "2026-10-20T00:00:00.000Z",
					messages: [
						{
							id: "message-1",
							authorType: "CUSTOMER",
							body: "<script>alert('test')</script>",
							createdAt: "2026-10-20T00:00:00.000Z",
						},
					],
				}}
			/>,
		);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("keeps all four locale leaf keys and interpolation names aligned", () => {
		for (const section of ["capabilities", "support"] as const) {
			const reference = leaves(section === "capabilities" ? en.admin.capabilities : en.support);
			for (const translated of [de, es, fr]) {
				const actual = leaves(
					section === "capabilities" ? translated.admin.capabilities : translated.support,
				);
				expect(Object.keys(actual).sort()).toEqual(Object.keys(reference).sort());
				for (const key of Object.keys(reference))
					expect(actual[key].match(/\{[^{}]+\}/g) ?? []).toEqual(
						reference[key].match(/\{[^{}]+\}/g) ?? [],
					);
			}
		}
	});
});
