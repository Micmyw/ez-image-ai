"use client";

import type { GenerationJourneyReport } from "@repo/config/generation-journey";
import { useTranslations } from "next-intl";

export function GenerationJourneyPanel({ data }: { data?: GenerationJourneyReport }) {
	const t = useTranslations("admin.conversion.journey");
	if (!data) return null;
	return (
		<section className="space-y-3 p-4 rounded-lg border">
			<h3 className="font-medium">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t("basis")}</p>
			<div className="gap-3 sm:grid-cols-3 grid">
				{(["clicks", "drafts", "admittedJobs"] as const).map((key) => (
					<div key={key}>
						<p className="text-sm">{t(key)}</p>
						<p className="text-2xl font-semibold">{data[key]}</p>
					</div>
				))}
			</div>
			<p className="text-sm">
				{t("links", {
					linked: data.linkedClicks,
					missing: data.unlinkedClicks,
					ambiguous: data.ambiguousClicks,
					jobs: data.jobsWithoutClick,
				})}
			</p>
			<p className="text-sm text-muted-foreground">
				{t("coverage", {
					unkeyed: data.unkeyedObservations,
					invalid: data.invalidEvents,
					legacy: data.legacyEvents,
				})}
			</p>
			{data.stages.length ? (
				<div className="overflow-x-auto">
					<table className="text-sm w-full text-left">
						<thead>
							<tr>
								{(["stage", "evidence", "events", "identities", "unkeyed"] as const).map((key) => (
									<th className="p-2" key={key}>
										{t(key)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data.stages.map((row) => (
								<tr key={`${row.evidence}:${row.stage}`} className="border-t">
									<td className="p-2">{t(`stages.${row.stage}` as "stages.source_selected")}</td>
									<td className="p-2">{t(row.evidence)}</td>
									<td className="p-2">{row.events}</td>
									<td className="p-2">{row.identities}</td>
									<td className="p-2">{row.unkeyed}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="text-sm">{t("empty")}</p>
			)}
			<p className="text-sm">
				{t("latency", {
					samples: data.visibleLatency.samples,
					excluded: data.visibleLatency.excluded,
					p50:
						data.visibleLatency.p50Ms === null
							? "—"
							: (data.visibleLatency.p50Ms / 1000).toFixed(1),
					p90:
						data.visibleLatency.p90Ms === null
							? "—"
							: (data.visibleLatency.p90Ms / 1000).toFixed(1),
				})}
			</p>
		</section>
	);
}
