"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

const JOB_STATUSES = [
	"RESERVED",
	"DISPATCH_QUEUED",
	"SUBMITTING",
	"PROVIDER_PENDING",
	"PROVIDER_RUNNING",
	"NEEDS_RECONCILIATION",
	"FINALIZING",
	"SUCCEEDED",
	"FAILED",
	"CANCELED",
] as const;

type JobStatus = (typeof JOB_STATUSES)[number];
type ProductFilter = "all" | "image-fast" | "image-quality";

interface OperationsFilters {
	productKey: ProductFilter;
	provider: string;
	model: string;
	status: "all" | JobStatus;
	from: string;
	to: string;
}

export interface GrowthOperationsData {
	generatedAt: string;
	summary: {
		jobs: number;
		succeeded: number;
		failed: number;
		successRate: number | null;
		latencyMs: { p50: number | null; p95: number | null };
		averageProviderCostMicros: string | null;
		moderationRejectionRate: number | null;
		repeatEditRate: number | null;
	};
	credits: { reserved: string; charged: string; released: string };
	failureCodes: Array<{ code: string; count: number }>;
	routes: Array<{
		productKey: "image-fast" | "image-quality";
		provider: string;
		model: string;
		status: JobStatus;
		jobs: number;
	}>;
	controls: {
		generationEnabled: boolean;
		products: Array<{
			productKey: "image-fast" | "image-quality";
			publicName: "Standard Edit" | "Quality Edit";
			enabled: boolean;
		}>;
	};
}

const emptyFilters: OperationsFilters = {
	productKey: "all",
	provider: "",
	model: "",
	status: "all",
	from: "",
	to: "",
};

function dateTimeIso(value: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function queryInput(filters: OperationsFilters) {
	const provider = filters.provider.trim();
	const model = filters.model.trim();
	const from = dateTimeIso(filters.from);
	const to = dateTimeIso(filters.to);
	return {
		...(filters.productKey === "all" ? {} : { productKey: filters.productKey }),
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(filters.status === "all" ? {} : { status: filters.status }),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
	};
}

export function GrowthOperationsPanel() {
	const t = useTranslations("admin.media.growth");
	const [draft, setDraft] = useState<OperationsFilters>(emptyFilters);
	const [filters, setFilters] = useState<OperationsFilters>(emptyFilters);
	const operations = useQuery(
		orpc.media.adminGrowthOperations.queryOptions({
			input: queryInput(filters),
			refetchInterval: 15_000,
		}),
	);

	return (
		<Card className="p-6">
			<div className="gap-3 flex flex-wrap items-start justify-between">
				<div>
					<h2 className="font-semibold text-xl">{t("title")}</h2>
					<p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
				</div>
				{operations.data && (
					<time className="text-xs text-muted-foreground" dateTime={operations.data.generatedAt}>
						{new Date(operations.data.generatedAt).toLocaleString()}
					</time>
				)}
			</div>

			<div className="mt-5 gap-3 md:grid-cols-2 xl:grid-cols-6 grid">
				<label className="space-y-1 text-sm">
					<span>{t("filters.product")}</span>
					<Select
						value={draft.productKey}
						onValueChange={(productKey) =>
							setDraft((current) => ({ ...current, productKey: productKey as ProductFilter }))
						}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("all")}</SelectItem>
							<SelectItem value="image-fast">Standard Edit</SelectItem>
							<SelectItem value="image-quality">Quality Edit</SelectItem>
						</SelectContent>
					</Select>
				</label>
				<FilterInput
					label={t("filters.provider")}
					value={draft.provider}
					onChange={(provider) => setDraft((current) => ({ ...current, provider }))}
				/>
				<FilterInput
					label={t("filters.model")}
					value={draft.model}
					onChange={(model) => setDraft((current) => ({ ...current, model }))}
				/>
				<label className="space-y-1 text-sm">
					<span>{t("filters.status")}</span>
					<Select
						value={draft.status}
						onValueChange={(status) =>
							setDraft((current) => ({ ...current, status: status as OperationsFilters["status"] }))
						}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("all")}</SelectItem>
							{JOB_STATUSES.map((status) => (
								<SelectItem key={status} value={status}>
									{status}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</label>
				<FilterInput
					label={t("filters.from")}
					type="datetime-local"
					value={draft.from}
					onChange={(from) => setDraft((current) => ({ ...current, from }))}
				/>
				<FilterInput
					label={t("filters.to")}
					type="datetime-local"
					value={draft.to}
					onChange={(to) => setDraft((current) => ({ ...current, to }))}
				/>
			</div>
			<Button className="mt-3" variant="outline" onClick={() => setFilters(draft)}>
				{t("apply")}
			</Button>

			{operations.isError ? (
				<p className="mt-5 text-sm text-destructive">{t("error")}</p>
			) : operations.data ? (
				<GrowthOperationsSummary data={operations.data} />
			) : (
				<p className="mt-5 text-sm text-muted-foreground">{t("loading")}</p>
			)}
		</Card>
	);
}

export function GrowthOperationsSummary({ data }: { data: GrowthOperationsData }) {
	const t = useTranslations("admin.media.growth");
	return (
		<div className="mt-6 space-y-5">
			<div className="gap-3 sm:grid-cols-2 xl:grid-cols-4 grid">
				<SummaryMetric title={t("metrics.jobs")} value={data.summary.jobs} />
				<SummaryMetric title={t("metrics.successRate")} value={percent(data.summary.successRate)} />
				<SummaryMetric
					title={t("metrics.latency")}
					value={`${data.summary.latencyMs.p50 ?? "-"} / ${data.summary.latencyMs.p95 ?? "-"} ms`}
				/>
				<SummaryMetric
					title={t("metrics.cost")}
					value={data.summary.averageProviderCostMicros ?? "-"}
				/>
				<SummaryMetric
					title={t("metrics.moderation")}
					value={percent(data.summary.moderationRejectionRate)}
				/>
				<SummaryMetric title={t("metrics.repeat")} value={percent(data.summary.repeatEditRate)} />
				<SummaryMetric
					title={t("metrics.credits")}
					value={`${data.credits.reserved} / ${data.credits.charged} / ${data.credits.released}`}
				/>
				<SummaryMetric
					title={t("metrics.terminal")}
					value={`${data.summary.succeeded} / ${data.summary.failed}`}
				/>
			</div>

			<div>
				<h3 className="font-medium">{t("controls.title")}</h3>
				<div className="mt-2 gap-2 flex flex-wrap">
					<ControlBadge label={t("controls.global")} enabled={data.controls.generationEnabled} />
					{data.controls.products.map((product) => (
						<ControlBadge
							key={product.productKey}
							label={product.publicName}
							enabled={product.enabled}
						/>
					))}
				</div>
			</div>

			<div className="gap-4 xl:grid-cols-[0.7fr_1.3fr] grid">
				<div>
					<h3 className="font-medium">{t("failures.title")}</h3>
					<div className="mt-2 divide-y rounded-md border">
						{data.failureCodes.length ? (
							data.failureCodes.map((failure) => (
								<div key={failure.code} className="gap-3 p-3 text-sm flex justify-between">
									<code>{failure.code}</code>
									<span>{failure.count}</span>
								</div>
							))
						) : (
							<p className="p-3 text-sm text-muted-foreground">{t("empty")}</p>
						)}
					</div>
				</div>
				<div>
					<h3 className="font-medium">{t("routes.title")}</h3>
					<div className="mt-2 overflow-x-auto rounded-md border">
						<table className="text-sm w-full text-left">
							<thead className="bg-muted/60">
								<tr>
									<th className="p-3">{t("routes.product")}</th>
									<th className="p-3">{t("routes.provider")}</th>
									<th className="p-3">{t("routes.model")}</th>
									<th className="p-3">{t("routes.status")}</th>
									<th className="p-3">{t("routes.jobs")}</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{data.routes.map((route) => (
									<tr key={`${route.productKey}:${route.provider}:${route.model}:${route.status}`}>
										<td className="p-3">
											{route.productKey === "image-fast" ? "Standard Edit" : "Quality Edit"}
										</td>
										<td className="p-3">{route.provider}</td>
										<td className="p-3">{route.model}</td>
										<td className="p-3">{route.status}</td>
										<td className="p-3">{route.jobs}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</div>
		</div>
	);
}

function percent(value: number | null): string {
	return value === null ? "-" : `${Math.round(value * 1_000) / 10}%`;
}

function FilterInput({
	label,
	value,
	onChange,
	type = "text",
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: "text" | "datetime-local";
}) {
	return (
		<label className="space-y-1 text-sm">
			<span>{label}</span>
			<Input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}

function SummaryMetric({ title, value }: { title: string; value: string | number }) {
	return (
		<div className="p-4 rounded-md border">
			<p className="text-xs text-muted-foreground">{title}</p>
			<p className="mt-2 font-semibold text-xl">{value}</p>
		</div>
	);
}

function ControlBadge({ label, enabled }: { label: string; enabled: boolean }) {
	const t = useTranslations("admin.media.growth");
	return (
		<Badge status={enabled ? "success" : "error"}>
			{label}: {enabled ? t("enabled") : t("disabled")}
		</Badge>
	);
}
