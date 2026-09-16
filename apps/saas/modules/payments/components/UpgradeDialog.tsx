"use client";

import { useSessionQuery } from "@auth/lib/api";
import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import { createPurchasesHelper } from "@repo/payments/lib/helper";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@repo/ui/components/dialog";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CrownIcon, LockKeyholeIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";
import type { UpgradeSelection } from "../lib/upgrade-selection";
import { PricingTable } from "./PricingTable";
import { PublicPricingPlans } from "./PublicPricingPlans";

export function UpgradeDialog({
	selection,
	onClose,
}: {
	selection: UpgradeSelection;
	onClose: () => void;
}) {
	const t = useTranslations();
	const locale = useLocale();
	const payment = usePaymentAction();
	const [view, setView] = useState(selection.view ?? "plans");
	const session = useSessionQuery();
	const user = session.data?.user;
	const registered = Boolean(user && user.isAnonymous !== true);
	const purchases = useQuery({
		...orpc.payments.listPurchases.queryOptions({ input: {} }),
		enabled: registered,
	});
	const { activePlan, activeSubscriptions, hasBlockingSubscription } = createPurchasesHelper(
		purchases.data ?? [],
	);
	const benefits =
		view === "plans"
			? (["allImageModels", "privateAssets", "editHistory", "aspectRatios"] as const).map((key) =>
					t(`pricing.${key}`),
				)
			: [
					t("pricing.oneTime"),
					t("pricing.privateAssets"),
					t("pricing.editHistory"),
					t("pricing.subscriberBonus", { percent: PUBLIC_CREDIT_PACKS[0].subscriberBonusPercent }),
				];
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !payment.action) onClose();
			}}
		>
			<DialogContent
				className="studio-theme studio-upgrade-dialog border-white/15 p-0 shadow-2xl max-h-[90dvh] overflow-y-auto bg-[#17121e] text-[#f6f2fb]"
				overlayProps={{ className: "bg-black/70 backdrop-blur-sm" }}
				closeDisabled={Boolean(payment.action)}
				closeLabel={t("studio.closePanel")}
			>
				<div className="min-w-0 md:grid-cols-[0.8fr_1.2fr] grid">
					<aside className="border-white/10 p-8 md:block hidden border-r bg-[radial-gradient(ellipse_at_top_left,#b79cff20,transparent_70%)]">
						<CrownIcon className="mb-5 size-9 text-[#b79cff]" aria-hidden />
						<h3 className="text-2xl font-semibold tracking-tight">
							{t(view === "plans" ? "pricing.upgrade.benefitsTitle" : "pricing.creditPacks")}
						</h3>
						<ul className="mt-7 gap-5 text-sm leading-6 grid text-[#cfc3dc]">
							{benefits.map((benefit) => (
								<li key={benefit} className="gap-3 flex">
									<CheckIcon className="mt-1 size-4 shrink-0 text-[#b79cff]" aria-hidden />
									<span>{benefit}</span>
								</li>
							))}
						</ul>
						<p className="mt-9 border-white/10 pt-5 text-xs leading-6 border-t text-[#a99cb5]">
							{view === "plans"
								? t("pricing.creditExpiry")
								: t("pricing.creditPackValidity", { months: PUBLIC_CREDIT_PACKS[0].expiryMonths })}
						</p>
						<div className="mt-5 gap-2 text-xs flex items-center text-[#c8b5f8]">
							<LockKeyholeIcon className="size-4" aria-hidden />
							{t("pricing.upgrade.secureHint")}
						</div>
					</aside>
					<div className="min-w-0 p-5 pt-10 sm:p-8">
						<DialogTitle className="pr-5 text-2xl leading-tight">
							{t("pricing.upgrade.title")}
						</DialogTitle>
						<DialogDescription className="mt-2 leading-6 text-[#b8adbf]">
							{t("pricing.upgrade.description")}
						</DialogDescription>
						<fieldset
							className="my-5 gap-4 border-white/10 flex border-b"
							aria-label={t("pricing.upgrade.purchaseType")}
						>
							{(["plans", "credit-packs"] as const).map((tab) => (
								<button
									type="button"
									key={tab}
									aria-pressed={view === tab}
									disabled={Boolean(payment.action)}
									onClick={() => setView(tab)}
									className={`min-h-11 pb-2 text-sm font-semibold border-b-2 transition disabled:cursor-wait ${view === tab ? "border-[#b79cff] text-[#d8c9ff]" : "border-transparent text-[#a99cb5]"}`}
								>
									{t(tab === "plans" ? "pricing.upgrade.plans" : "pricing.creditPacks")}
								</button>
							))}
						</fieldset>
						{view === "credit-packs" ? (
							<PublicPricingPlans locale={locale} initialView="credit-packs" hideViewToggle />
						) : null}
						<div hidden={view !== "plans"}>
							{(session.isError || (registered && purchases.isError)) && (
								<p role="alert" className="mb-3 text-sm text-destructive">
									{t("pricing.checkoutUnavailable")}
								</p>
							)}
							<PricingTable
								compact
								initialSelection={selection}
								userId={registered ? user?.id : undefined}
								activePlanId={activePlan?.id}
								subscriptionBlocked={hasBlockingSubscription}
								subscriptionBlockers={activeSubscriptions}
								accountLoading={
									session.isPending ||
									session.isError ||
									(registered && (purchases.isPending || purchases.isError))
								}
							/>
							{hasBlockingSubscription && (
								<Link
									className="mt-5 min-h-11 px-5 text-sm font-semibold text-white inline-flex items-center rounded-xl bg-[#8065f5]"
									href="/settings/billing?full=true"
									onClick={onClose}
								>
									{t("studio.panels.billing")}
								</Link>
							)}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
