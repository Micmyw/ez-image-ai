"use client";

import type { ConversionFunnel } from "@repo/api/modules/admin-analytics/conversion-types";
import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useAdminOperation } from "../lib/capabilities-client";
import {
	CapabilityError,
	CapabilityLoading,
	CapabilitySection,
	CapabilitySelect,
} from "./CapabilityUi";

const steps = [
	"signups",
	"generated",
	"succeeded",
	"purchaseClicked",
	"checkouts",
	"paid",
] as const;

export function ConversionFunnelPanel() {
	const t = useTranslations("admin.conversion");
	const ranges = useTranslations("admin.capabilities.analytics.ranges");
	const [range, setRange] = useState<"24h" | "7d" | "30d">("30d");
	const [source, setSource] = useState("__all__");
	const [device, setDevice] = useState("__all__");
	const query = useAdminOperation<ConversionFunnel>("analytics_conversion", {
		range,
		...(source !== "__all__" ? { source } : {}),
		...(device !== "__all__" ? { device } : {}),
	});
	const data = query.data;
	const label = (value: string) =>
		value === "unknown" ? t("unknown") : value === "direct" ? t("direct") : value;
	return (
		<CapabilitySection title={t("title")} description={t("basis")}>
			<div className="gap-3 sm:grid-cols-4 grid">
				<CapabilitySelect
					label={t("range")}
					value={range}
					onChange={setRange}
					options={(["24h", "7d", "30d"] as const).map((value) => ({
						value,
						label: ranges(value),
					}))}
				/>
				<CapabilitySelect
					label={t("source")}
					value={source}
					onChange={setSource}
					options={[
						{ value: "__all__", label: t("all") },
						...(data?.sources ?? []).map((value) => ({ value, label: label(value) })),
					]}
				/>
				<CapabilitySelect
					label={t("device")}
					value={device}
					onChange={setDevice}
					options={["__all__", "mobile", "desktop", "tablet", "unknown"].map((value) => ({
						value,
						label: value !== "__all__" ? t(value as "mobile") : t("all"),
					}))}
				/>
				<Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
					{t("refresh")}
				</Button>
			</div>
			<CapabilityError error={query.error} />
			<CapabilityLoading loading={query.isPending} />
			{data && (
				<>
					<div className="p-4 space-y-2 rounded-lg border">
						<p className="font-medium">
							{t("aggregateTitle", { views: data.aggregateTraffic.views })}
						</p>
						<p className="text-sm text-muted-foreground">
							{t("aggregateBasis", { since: data.aggregateTraffic.since })}
						</p>
						<div className="gap-4 text-sm flex flex-wrap">
							{data.aggregateTraffic.sources.map((row) => (
								<span key={row.source}>
									{label(row.source)}: {row.views}
								</span>
							))}
						</div>
					</div>
					<p className="text-sm">{t("traffic", data.traffic)}</p>
					<p className="text-sm">
						{t("linkedVisitors", {
							registeredBrowsers: data.visitorCohort.registeredBrowsers,
							successfulBrowsers: data.visitorCohort.successfulBrowsers,
							paidBrowsers: data.visitorCohort.paidBrowsers,
							rate:
								data.visitorCohort.registrationRate === null
									? "—"
									: `${(data.visitorCohort.registrationRate * 100).toFixed(1)}%`,
						})}
					</p>
					<p className="text-sm text-muted-foreground">
						{t("coverage", {
							known: data.coverage.usersWithBrowserEvents,
							total: data.totals.signups,
							unknown: data.coverage.unknownSourceUsers,
							internal: data.coverage.internalBrowsersExcluded,
						})}
					</p>
					{!data.coverage.firstObservedAt && (
						<output className="text-sm text-muted-foreground">{t("noObservations")}</output>
					)}
					<div className="gap-3 sm:grid-cols-3 xl:grid-cols-6 grid">
						{steps.map((step) => (
							<div key={step} className="p-3 rounded-lg border">
								<p className="text-sm text-muted-foreground">{t(step)}</p>
								<p className="text-2xl font-semibold">{data.totals[step]}</p>
								<meter
									className="w-full"
									aria-label={t(step)}
									min={0}
									max={Math.max(1, data.totals.signups)}
									value={data.totals[step]}
								/>
								<p className="text-xs text-muted-foreground">
									{data.totals.signups
										? `${((100 * data.totals[step]) / data.totals.signups).toFixed(1)}%`
										: "—"}{" "}
									{t("ofSignups")}
								</p>
							</div>
						))}
					</div>
					<p className="text-sm">{t("firstAttempt", data.firstAttempt)}</p>
					<details className="p-4 rounded-lg border">
						<summary className="font-medium cursor-pointer">{t("generationTitle")}</summary>
						<p className="text-sm my-2 text-muted-foreground">{t("generationBasis")}</p>
						<ul className="space-y-2 text-sm">
							{data.generationObservations.map((row, index) => (
								<li key={index}>
									{t(row.mediaKind as "image")} ·{" "}
									{t(`generationPhases.${row.phase}` as "generationPhases.editing")} ·{" "}
									{row.publicModel ?? "—"} ·{" "}
									{t("generationInputs", {
										length: row.textLength ?? "—",
										inputs: row.inputCount ?? "—",
										observations: row.observations,
									})}
									{row.reason && (
										<> · {t(`generationReasons.${row.reason}` as "generationReasons.unknown")}</>
									)}
								</li>
							))}
						</ul>
					</details>
					<div className="overflow-x-auto">
						<table className="text-sm w-full text-left">
							<thead>
								<tr className="border-b">
									{["source", "browsers", ...steps].map((key) => (
										<th className="p-2" key={key}>
											{t(key as "source")}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row) => (
									<tr className="border-b" key={row.source}>
										<td className="p-2">{label(row.source)}</td>
										<td className="p-2">{row.browsers}</td>
										{steps.map((step) => (
											<td className="p-2" key={step}>
												{row[step]}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="text-xs text-muted-foreground">{t("sourceBasis")}</p>
					<h3 className="font-medium">{t("checkoutTitle")}</h3>
					<div className="overflow-x-auto">
						<table className="text-sm w-full text-left">
							<thead>
								<tr className="border-b">
									{["productKind", "clicked", "requested", "redirected", "failed"].map((key) => (
										<th className="p-2" key={key}>
											{t(key as "clicked")}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{data.checkoutProducts.map((row) => (
									<tr className="border-b" key={row.productKind}>
										<td className="p-2">{t(row.productKind as "PLAN")}</td>
										{(["clicked", "requested", "redirected", "failed"] as const).map((key) => (
											<td className="p-2" key={key}>
												{row[key]}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{data.checkoutFailures.length > 0 && (
						<ul className="space-y-1 text-sm">
							{data.checkoutFailures.map((row) => (
								<li key={row.category}>
									{t(`checkoutErrors.${row.category}` as "checkoutErrors.unknown")}: {row.events}
								</li>
							))}
						</ul>
					)}
					<h3 className="font-medium">{t("failureTitle")}</h3>
					{data.failures.length ? (
						<ul className="space-y-1 text-sm">
							{data.failures.map((row) => (
								<li key={row.reason}>
									{t(row.reason as "OTHER")}: {row.jobs}
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm">{t("noFailures")}</p>
					)}
				</>
			)}
		</CapabilitySection>
	);
}
