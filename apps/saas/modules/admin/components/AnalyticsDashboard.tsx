"use client";

import {
	adminAnalyticsDimensions,
	adminAnalyticsReportInputSchema,
	type AdminAnalyticsFunnel,
	type AdminAnalyticsOverview,
	type AdminAnalyticsReport,
} from "@repo/api/modules/admin-analytics/types";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { moneyMicros, sourceFilterInput, useAdminOperation } from "../lib/capabilities-client";
import {
	CapabilityError,
	CapabilityLoading,
	CapabilitySection,
	CapabilitySelect,
} from "./CapabilityUi";
import { ConversionFunnelPanel } from "./ConversionFunnelPanel";

type Dimension = (typeof adminAnalyticsDimensions)[number];
type FilterMode = "all" | "empty" | "unknown" | "value";

export function RevenueTable({
	rows,
}: {
	rows: Array<{ currency: string; grossMicros: string; refundedMicros: string; netMicros: string }>;
}) {
	const t = useTranslations("admin.capabilities.analytics");
	const locale = useLocale();
	return (
		<div className="overflow-x-auto">
			<table className="text-sm w-full text-left">
				<thead>
					<tr className="border-b">
						{["currency", "gross", "refunded", "net"].map((key) => (
							<th key={key} className="p-3 font-medium">
								{t(key as "currency")}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.currency} className="border-b">
							<td className="p-3">{row.currency}</td>
							<td className="p-3">{moneyMicros(row.grossMicros, row.currency, locale)}</td>
							<td className="p-3">{moneyMicros(row.refundedMicros, row.currency, locale)}</td>
							<td className="p-3">{moneyMicros(row.netMicros, row.currency, locale)}</td>
						</tr>
					))}
				</tbody>
			</table>
			<CapabilityLoading loading={false} empty={rows.length === 0} />
		</div>
	);
}

function Coverage({ coverage }: { coverage: AdminAnalyticsOverview["coverage"] }) {
	const t = useTranslations("admin.capabilities.analytics");
	return (
		<details className="p-3 text-sm rounded-lg border">
			<summary className="font-medium cursor-pointer">{t("coverage")}</summary>
			<dl className="mt-3 gap-2 sm:grid-cols-2 grid">
				{(
					[
						"unknownPaymentFacts",
						"unknownPaymentDates",
						"unknownPaymentUsers",
						"unknownRenewalKinds",
						"unknownAttributionUsers",
						"excludedTestPayments",
						"unclassifiedPayments",
						"unclassifiedRefunds",
						"unlinkedCheckoutPayments",
						"unclassifiedSubscriptions",
					] as const
				).map((key) => (
					<div key={key} className="gap-3 flex justify-between">
						<dt>{t(key)}</dt>
						<dd>{coverage[key]}</dd>
					</div>
				))}
			</dl>
		</details>
	);
}

export function AnalyticsOverview({ data }: { data: AdminAnalyticsOverview }) {
	const t = useTranslations("admin.capabilities.analytics");
	const metrics = [
		["users", data.users.total],
		["new24h", data.users.new24h],
		["activeSubscriptions", data.subscriptions.active],
		["trialSubscriptions", t("unavailable")],
		["openTickets", data.openTickets],
	] as const;
	return (
		<div className="space-y-5">
			<dl className="gap-3 sm:grid-cols-2 xl:grid-cols-5 grid">
				{metrics.map(([label, value]) => (
					<div key={label} className="p-4 rounded-xl border">
						<dt className="text-sm text-muted-foreground">{t(label)}</dt>
						<dd className="mt-2 text-2xl font-semibold">{value}</dd>
					</div>
				))}
			</dl>
			<p className="text-sm text-muted-foreground">{t("usersBasis")}</p>
			<h3 className="font-medium">{t("revenue30d")}</h3>
			<p className="text-sm text-muted-foreground">{t("overviewBasis")}</p>
			<RevenueTable rows={data.revenue30d} />
			<Coverage coverage={data.coverage} />
		</div>
	);
}

export function AnalyticsDashboard() {
	const t = useTranslations("admin.capabilities.analytics");
	const common = useTranslations("admin.capabilities.common");
	const [environment, setEnvironment] = useState<"production" | "test">("production");
	const overview = useAdminOperation<AdminAnalyticsOverview>("analytics_overview", { environment });
	const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
	const [dimension, setDimension] = useState<Dimension>("utm_source");
	const [filterMode, setFilterMode] = useState<FilterMode>("all");
	const [filterValue, setFilterValue] = useState("");
	const [filters, setFilters] = useState<Record<string, unknown>>({
		range: "7d",
		groupBy: "utm_source",
		filters: {},
	});
	const funnel = useAdminOperation<AdminAnalyticsFunnel>("analytics_funnel", {
		...filters,
		environment,
	});
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [reportInput, setReportInput] = useState<Record<string, unknown>>({ compare: true });
	const [reportError, setReportError] = useState(false);
	const report = useAdminOperation<AdminAnalyticsReport>("analytics_report", {
		...reportInput,
		environment,
	});

	return (
		<div className="space-y-6">
			<ConversionFunnelPanel />
			<CapabilitySection title={t("title")} description={t("description")}>
				<CapabilitySelect
					label={t("environment")}
					value={environment}
					onChange={setEnvironment}
					options={[
						{ value: "production", label: t("production") },
						{ value: "test", label: t("test") },
					]}
				/>
				<p className="text-sm text-muted-foreground">{t("environmentHint")}</p>
				<Button
					size="sm"
					variant="outline"
					onClick={() => overview.refetch()}
					disabled={overview.isFetching}
				>
					{common("refresh")}
				</Button>
				<CapabilityError error={overview.error} />
				<CapabilityLoading loading={overview.isPending} />
				{overview.data && <AnalyticsOverview data={overview.data} />}
			</CapabilitySection>
			<CapabilitySection title={t("funnelTitle")} description={t("funnelBasis")}>
				<form
					className="gap-3 sm:grid-cols-2 xl:grid-cols-5 grid items-end"
					onSubmit={(event) => {
						event.preventDefault();
						const value = sourceFilterInput(filterMode, filterValue);
						setFilters({
							range,
							groupBy: dimension,
							filters: value === undefined ? {} : { [dimension]: value },
						});
					}}
				>
					<CapabilitySelect
						label={t("range")}
						value={range}
						onChange={setRange}
						options={["24h", "7d", "30d"].map((value) => ({
							value: value as typeof range,
							label: t(`ranges.${value}` as "ranges.24h"),
						}))}
					/>
					<CapabilitySelect
						label={t("dimension")}
						value={dimension}
						onChange={(value) => {
							setDimension(value);
							setFilterMode("all");
							setFilterValue("");
						}}
						options={adminAnalyticsDimensions.map((value) => ({
							value,
							label: t(`dimensions.${value}`),
						}))}
					/>
					<CapabilitySelect
						label={t("filter")}
						value={filterMode}
						onChange={setFilterMode}
						options={(["all", "empty", "unknown", "value"] as const).map((value) => ({
							value,
							label: t(`filters.${value}`),
						}))}
					/>
					<label className="space-y-1 text-sm">
						<span>{t("filterValue")}</span>
						<Input
							disabled={filterMode !== "value"}
							required={filterMode === "value"}
							value={filterValue}
							maxLength={512}
							onChange={(event) => setFilterValue(event.target.value)}
						/>
					</label>
					<Button type="submit">{common("apply")}</Button>
				</form>
				<p className="text-sm text-muted-foreground">{t("sourceBasis")}</p>
				<CapabilityError error={funnel.error} />
				<CapabilityLoading loading={funnel.isPending} />
				{funnel.data && <FunnelResults data={funnel.data} />}
			</CapabilitySection>
			<CapabilitySection title={t("reportTitle")} description={t("reportBasis")}>
				<form
					className="gap-3 flex flex-wrap items-end"
					onSubmit={(event) => {
						event.preventDefault();
						const parsed = adminAnalyticsReportInputSchema.safeParse({
							...(from ? { from: new Date(from).toISOString() } : {}),
							...(to ? { to: new Date(to).toISOString() } : {}),
							compare: true,
						});
						setReportError(!parsed.success || Boolean(from) !== Boolean(to));
						if (parsed.success && Boolean(from) === Boolean(to)) setReportInput(parsed.data);
					}}
				>
					<label className="space-y-1 text-sm">
						<span>{t("from")}</span>
						<Input
							type="datetime-local"
							value={from}
							onChange={(event) => setFrom(event.target.value)}
						/>
					</label>
					<label className="space-y-1 text-sm">
						<span>{t("to")}</span>
						<Input
							type="datetime-local"
							value={to}
							onChange={(event) => setTo(event.target.value)}
						/>
					</label>
					<Button type="submit">{common("apply")}</Button>
				</form>
				<p className="text-sm text-muted-foreground">
					{t("timeZone", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
				</p>
				{reportError && (
					<p role="alert" className="text-sm text-destructive">
						{t("rangeError")}
					</p>
				)}
				<CapabilityError error={report.error} />
				<CapabilityLoading loading={report.isPending} />
				{report.data && (
					<div className="space-y-5">
						<ReportPeriod data={report.data.current} previous={false} />
						{report.data.previous && <ReportPeriod data={report.data.previous} previous />}
						<Coverage coverage={report.data.coverage} />
					</div>
				)}
			</CapabilitySection>
		</div>
	);
}

function FunnelResults({ data }: { data: AdminAnalyticsFunnel }) {
	const t = useTranslations("admin.capabilities.analytics");
	const common = useTranslations("admin.capabilities.common");
	return (
		<div className="space-y-5">
			<div className="gap-3 sm:grid-cols-3 grid">
				{(["signups", "checkouts", "paid"] as const).map((stage) => (
					<div key={stage} className="p-4 rounded-lg border">
						<p className="text-sm">{t(stage)}</p>
						<p className="mt-1 text-2xl font-semibold">{data.totals[stage]}</p>
						<div className="mt-3 h-2 rounded bg-muted" aria-hidden>
							<div
								className="h-2 rounded bg-primary"
								style={{
									width: `${data.totals.signups ? (data.totals[stage] / data.totals.signups) * 100 : 0}%`,
								}}
							/>
						</div>
					</div>
				))}
			</div>
			<div className="overflow-x-auto">
				<table className="text-sm w-full text-left">
					<thead>
						<tr className="border-b">
							{["source", "signups", "checkouts", "paid", "conversion"].map((key) => (
								<th key={key} className="p-3">
									{t(key as "source")}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.rows.map((row) => (
							<tr
								className="border-b"
								key={row.value === null ? "__unknown__" : `source:${row.value}`}
							>
								<td className="p-3 break-all">
									{row.value === null
										? t("filters.unknown")
										: row.value === ""
											? t("filters.empty")
											: row.value}
								</td>
								<td className="p-3">{row.signups}</td>
								<td className="p-3">{row.checkouts}</td>
								<td className="p-3">{row.paid}</td>
								<td className="p-3">
									{row.signups ? `${((row.paid / row.signups) * 100).toFixed(1)}%` : "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{data.rows.length === 0 && <p className="text-sm">{common("empty")}</p>}
			{data.rowsTruncated && <p className="text-sm">{t("truncated")}</p>}
			<Coverage coverage={data.coverage} />
		</div>
	);
}

function ReportPeriod({
	data,
	previous,
}: {
	data: AdminAnalyticsReport["current"];
	previous: boolean;
}) {
	const t = useTranslations("admin.capabilities.analytics");
	return (
		<div className="space-y-3 p-4 rounded-lg border">
			<h3 className="font-medium">{t(previous ? "previousPeriod" : "currentPeriod")}</h3>
			<p className="text-xs text-muted-foreground">
				{data.from} – {data.to}
			</p>
			<dl className="gap-3 sm:grid-cols-3 grid">
				{(
					[
						["signups", data.users.new],
						["checkouts", data.checkout.users],
						["paid", data.payments.payingUsers],
						["renewals", data.payments.renewals],
						["newSubscriptions", data.subscriptions.new],
						["canceledSubscriptions", data.subscriptions.canceled],
					] as const
				).map(([key, value]) => (
					<div key={key}>
						<dt className="text-sm text-muted-foreground">{t(key)}</dt>
						<dd className="text-lg font-semibold">{value}</dd>
					</div>
				))}
			</dl>
			<RevenueTable rows={data.payments.revenue} />
		</div>
	);
}
