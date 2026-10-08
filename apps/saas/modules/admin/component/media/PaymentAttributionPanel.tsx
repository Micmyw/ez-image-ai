"use client";

import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import type { CheckoutAttribution } from "@repo/utils";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";

interface PaymentAttributionRow {
	id: string;
	ownerType: "USER" | "ORGANIZATION" | null;
	ownerId: string | null;
	provider: string;
	productKind: "PLAN" | "CREDIT_PACK";
	status: string | null;
	createdAt: string;
	attribution: CheckoutAttribution | null;
	type?: "SUBSCRIPTION" | "ONE_TIME";
	planKey?: string;
	interval?: string;
}

export function PaymentAttributionPanel() {
	const t = useTranslations("admin.media.paymentAttribution");
	const fieldId = useId();
	const [reference, setReference] = useState("");
	const [selectedReference, setSelectedReference] = useState("");
	const query = useQuery({
		...orpc.payments.listAdminPaymentAttribution.queryOptions({
			input: { limit: 20, ...(selectedReference ? { reference: selectedReference } : {}) },
		}),
		retry: false,
		refetchOnWindowFocus: false,
	});
	return (
		<Card className="space-y-4 p-5" id="payment-attribution">
			<h2 className="text-xl font-semibold">{t("title")}</h2>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					const next = reference.trim();
					if (next === selectedReference) void query.refetch();
					else setSelectedReference(next);
				}}
			>
				<label className="text-sm font-medium" htmlFor={fieldId}>
					{t("reference")}
				</label>
				<div className="gap-2 flex flex-wrap">
					<Input
						id={fieldId}
						value={reference}
						maxLength={128}
						className="min-w-0 flex-1"
						onChange={(event) => setReference(event.target.value)}
					/>
					<Button type="submit" variant="outline" disabled={query.isFetching}>
						{t("find")}
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={query.isFetching}
						onClick={() => {
							setReference("");
							if (!selectedReference) void query.refetch();
							else setSelectedReference("");
						}}
					>
						{t("recent")}
					</Button>
				</div>
			</form>
			{query.isPending && <output className="text-sm block">{t("loading")}</output>}
			{query.isError && (
				<p className="text-sm text-destructive" role="alert">
					{t("loadError")}
				</p>
			)}
			{query.data && !query.isError && (
				<PaymentAttributionRecords
					purchases={query.data.purchases}
					checkouts={query.data.checkouts}
				/>
			)}
		</Card>
	);
}

export function PaymentAttributionRecords({
	purchases,
	checkouts,
}: {
	purchases: PaymentAttributionRow[];
	checkouts: PaymentAttributionRow[];
}) {
	const t = useTranslations("admin.media.paymentAttribution");
	return (
		<div className="space-y-5">
			<p className="text-sm text-muted-foreground">{t("unknownHint")}</p>
			{(
				[
					{ key: "purchases", rows: purchases },
					{ key: "checkouts", rows: checkouts },
				] as const
			).map(({ key, rows }) => (
				<section key={key} className="space-y-3" aria-label={t(key)}>
					<h3 className="font-semibold">{t(key)}</h3>
					{rows.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("empty")}</p>
					) : (
						<div className="space-y-3">
							{rows.map((row) => (
								<PaymentAttributionRecord key={row.id} row={row} />
							))}
						</div>
					)}
				</section>
			))}
		</div>
	);
}

function PaymentAttributionRecord({ row }: { row: PaymentAttributionRow }) {
	const t = useTranslations("admin.media.paymentAttribution");
	const format = useFormatter();
	const registration = row.attribution?.registration;
	const date = (value: string | undefined) =>
		value
			? format.dateTime(new Date(value), {
					dateStyle: "medium",
					timeStyle: "short",
					timeZone: "UTC",
				})
			: t("unknown");
	return (
		<article className="p-4 space-y-3 rounded-md border">
			<div className="gap-2 text-sm flex flex-wrap justify-between">
				<code className="break-all">{row.id}</code>
				<span>
					{row.provider} · {row.status ?? t("unknown")}
				</span>
			</div>
			<dl className="gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3 grid">
				<Field
					label={t("owner")}
					value={row.ownerId ? `${row.ownerType}: ${row.ownerId}` : t("unknown")}
				/>
				<Field
					label={t("product")}
					value={[
						t(row.productKind === "CREDIT_PACK" ? "creditPack" : "plan"),
						row.planKey,
						row.interval,
					]
						.filter(Boolean)
						.join(" · ")}
				/>
				<Field label={t("createdAt")} value={date(row.createdAt)} />
				<Field
					label={t("registrationSource")}
					value={registration ? t(`sources.${registration.source}`) : t("unknown")}
				/>
				<Field label={t("referrer")} value={registration?.referrerOrigin ?? t("unknown")} />
				<Field label={t("landingPath")} value={registration?.landingPath ?? t("unknown")} />
				<Field
					label={t("campaign")}
					value={
						registration
							? [registration.utmSource, registration.utmMedium, registration.utmCampaign]
									.filter(Boolean)
									.join(" / ") || t("unknown")
							: t("unknown")
					}
				/>
				<Field label={t("capturedAt")} value={date(registration?.capturedAt)} />
				<Field label={t("registeredAt")} value={date(registration?.registeredAt)} />
				<Field label={t("triggerPath")} value={row.attribution?.triggerPath ?? t("unknown")} />
				<Field label={t("triggeredAt")} value={date(row.attribution?.triggeredAt)} />
			</dl>
			{row.type === "SUBSCRIPTION" && (
				<p className="text-sm text-muted-foreground">{t("renewalHint")}</p>
			)}
		</article>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="break-all">{value}</dd>
		</div>
	);
}
