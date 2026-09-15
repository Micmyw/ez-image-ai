import { readdir } from "node:fs/promises";

import { BILLING_PRICING_VERSION, CREDIT_PACK_KEYS, getPlanEntitlement } from "@repo/config";
import { createCreditPackCheckoutSnapshot } from "@repo/config/server";
import { assertLiveBillingDataIsolation, db } from "@repo/database";
import {
	getCreditPackProviderProductId,
	getPaymentProvider,
	getProviderPriceIdByPlanId,
	isPaymentProviderConfigured,
	normalizeProviderPaymentEvent,
	paymentReconciliationScope,
} from "@repo/payments";

import {
	isExactBillingPlanSnapshot,
	isExactCreditPackBillingPlanSnapshot,
} from "../modules/payments/provider-availability";

type Provider = "paypal" | "waffo";
const providers = (["paypal", "waffo"] as const).filter((provider) =>
	Boolean(process.env[provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"]),
);
const checks: Array<{
	name: string;
	status: "PASS" | "FAIL" | "NOT_COMPLETED";
	detail?: string | number;
}> = [];
const record = (name: string, pass: boolean, detail?: string | number) =>
	checks.push({
		name,
		status: pass ? "PASS" : "FAIL",
		...(detail === undefined ? {} : { detail }),
	});

function snapshots(provider: Provider) {
	const providerEnvironment =
		process.env[provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"];
	const plans = (["creator", "ultimate", "studio"] as const).flatMap((planId) => {
		const plan = getPlanEntitlement(planId);
		return (["month", "year"] as const).map((interval) => {
			const price = plan.prices.find((price) => price.interval === interval)!;
			return {
				provider,
				providerPriceId: getProviderPriceIdByPlanId(provider, planId, {
					type: "subscription",
					interval,
				}),
				productKind: "PLAN" as const,
				version: 1,
				active: true,
				name: planId,
				creditsPerPeriod: BigInt(plan.monthlyCredits),
				priceMicros: BigInt(Math.round(price.amount * 1000000)),
				currency: price.currency,
				metadata: {
					planId,
					interval,
					version: 1,
					billingPricingVersion: BILLING_PRICING_VERSION,
					providerEnvironment,
				},
			};
		});
	});
	const packs = CREDIT_PACK_KEYS.map((packKey) => {
		const pack = createCreditPackCheckoutSnapshot(packKey, false);
		return {
			provider,
			providerPriceId: getCreditPackProviderProductId(provider, packKey),
			productKind: "CREDIT_PACK" as const,
			version: 1,
			active: true,
			name: packKey,
			creditsPerPeriod: BigInt(pack.baseCredits),
			priceMicros: BigInt(pack.priceMicros),
			currency: pack.currency,
			metadata: {
				productKind: "CREDIT_PACK",
				packKey,
				version: 1,
				catalogVersion: pack.catalogVersion,
				pricingVersion: pack.pricingVersion,
				expiryMonths: pack.expiryMonths,
				providerEnvironment,
			},
		};
	});
	return [...plans, ...packs];
}

async function main() {
	if (process.argv.includes("--manifest")) {
		console.log(
			JSON.stringify(
				providers.flatMap(snapshots),
				(_, value) => (typeof value === "bigint" ? value.toString() : value),
				2,
			),
		);
		return;
	}
	record("payment_provider_selected", providers.length > 0);
	for (const provider of providers) {
		record(
			`${provider}.live_environment`,
			process.env[provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"] ===
				(provider === "paypal" ? "live" : "prod"),
		);
		record(`${provider}.credentials_present`, isPaymentProviderConfigured(provider));
		for (const plan of snapshots(provider))
			record(
				`${provider}.${plan.name}.${"interval" in plan.metadata ? plan.metadata.interval : "one-time"}.mapping`,
				Boolean(plan.providerPriceId),
			);
	}
	const origin = process.env.NEXT_PUBLIC_SAAS_URL ?? "";
	record(
		"public_https_origin",
		/^https:\/\/[^/]+\/?$/.test(origin) && !origin.includes("localhost"),
	);
	const expected = await readdir(new URL("../../database/prisma/migrations/", import.meta.url));
	const applied = await db.$queryRaw<
		Array<{ migration_name: string }>
	>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
	const missing = expected.filter(
		(name) => /^\d/.test(name) && !applied.some((row) => row.migration_name === name),
	);
	record("database_migrations", missing.length === 0, missing.length);
	if (missing.length === 0) {
		try {
			await assertLiveBillingDataIsolation(db);
			record("test_payment_data_isolated", true);
		} catch {
			record("test_payment_data_isolated", false, "BILLING_TEST_DATA_ISOLATION_REQUIRED");
		}
		for (const provider of providers) {
			for (const expectedPlan of snapshots(provider)) {
				const saved = expectedPlan.providerPriceId
					? await db.billingPlan.findUnique({
							where: {
								provider_providerPriceId: {
									provider,
									providerPriceId: expectedPlan.providerPriceId,
								},
							},
						})
					: null;
				const exact =
					expectedPlan.productKind === "PLAN"
						? isExactBillingPlanSnapshot(saved, provider, expectedPlan.providerPriceId ?? "", {
								planId: expectedPlan.metadata.planId,
								interval: expectedPlan.metadata.interval,
							})
						: isExactCreditPackBillingPlanSnapshot(
								saved,
								provider,
								expectedPlan.providerPriceId ?? "",
								{ packKey: expectedPlan.metadata.packKey },
							);
				record(
					`${provider}.${expectedPlan.name}.${expectedPlan.productKind === "PLAN" ? expectedPlan.metadata.interval : "one-time"}.snapshot`,
					exact,
				);
			}
			if (isPaymentProviderConfigured(provider)) {
				const checkpoint = await db.paymentReconciliationCheckpoint.findUnique({
					where: { id: paymentReconciliationScope(provider) },
				});
				record(
					`${provider}.reconciliation_recent`,
					Boolean(
						checkpoint?.lastCompletedAt &&
						checkpoint.lastCompletedAt.getTime() > Date.now() - 90 * 60 * 1000 &&
						!checkpoint.lastError,
					),
				);
			}
		}
		const unresolved = await db.paymentEvent.count({
			where: { status: { in: ["FAILED", "DEAD_LETTER"] } },
		});
		record("payment_failures_resolved", unresolved === 0, unresolved);
		const renewalUnknown = await db.subscription.count({
			where: { status: "EXPIRED", cancelAtPeriodEnd: false },
		});
		record("expired_renewal_states_resolved", renewalUnknown === 0, renewalUnknown);
		const pendingTerminations = await db.subscription.count({
			where: { refundTerminationRequestedAt: { not: null }, refundTerminatedAt: null },
		});
		record("refund_terminations_confirmed", pendingTerminations === 0, pendingTerminations);
	}
	for (const provider of providers) {
		if (!process.argv.includes("--check-provider") || !isPaymentProviderConfigured(provider)) {
			checks.push({ name: `${provider}.authenticated_provider_read`, status: "NOT_COMPLETED" });
			continue;
		}
		try {
			const source = getPaymentProvider(provider)?.listPaymentEvents;
			if (!source) throw new Error("UNAVAILABLE");
			const page = await source({
				since: new Date(Date.now() - 86400000),
				until: new Date(Date.now() - 60000),
				cursor: null,
				limit: 50,
			});
			for (const event of page.events) normalizeProviderPaymentEvent(provider, event.envelope);
			record(`${provider}.authenticated_provider_read`, true, page.events.length);
		} catch {
			record(`${provider}.authenticated_provider_read`, false, "PROVIDER_READ_OR_CONTRACT_FAILED");
		}
	}
	const readyForLiveSmokeTest = checks.every((check) => check.status === "PASS");
	console.log(
		JSON.stringify(
			{
				readyForLiveSmokeTest,
				collectionEnabled: process.env.BILLING_ENABLED === "true",
				productionPaymentCertification: "NOT_COMPLETED",
				checks,
			},
			null,
			2,
		),
	);
	if (!readyForLiveSmokeTest) process.exitCode = 1;
}

main()
	.catch(() => {
		console.error(
			JSON.stringify({
				readyForLiveSmokeTest: false,
				checks,
				error: "BILLING_PREFLIGHT_DATABASE_OR_CONFIGURATION_FAILED",
			}),
		);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
