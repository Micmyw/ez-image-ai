"use client";

import type { ConversionFunnel } from "@repo/api/modules/admin-analytics/conversion-types";
import { useTranslations } from "next-intl";

export function HomepageIdeaAnalytics({ rows }: { rows: ConversionFunnel["homepageIdeas"] }) {
	const t = useTranslations("admin.conversion.homepageIdeas");
	return (
		<section className="space-y-3 p-4 rounded-lg border">
			<h3 className="font-medium">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t("basis")}</p>
			<div className="overflow-x-auto">
				<table className="text-sm w-full text-left">
					<caption className="sr-only">{t("title")}</caption>
					<thead>
						<tr className="border-b">
							{(
								[
									"idea",
									"placement",
									"previewVisitors",
									"previewClicks",
									"createVisitors",
									"createClicks",
								] as const
							).map((key) => (
								<th scope="col" className="p-2 whitespace-nowrap" key={key}>
									{t(key)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr className="border-b" key={`${row.placement}:${row.idea}`}>
								<th scope="row" className="p-2 font-normal">
									{t(`ideas.${row.idea}`)}
								</th>
								<td className="p-2">{t(`placements.${row.placement}`)}</td>
								<td className="p-2 tabular-nums">
									{row.placement === "showcase" ? row.previewVisitors : "—"}
								</td>
								<td className="p-2 tabular-nums">
									{row.placement === "showcase" ? row.previewClicks : "—"}
								</td>
								<td className="p-2 tabular-nums">{row.createVisitors}</td>
								<td className="p-2 tabular-nums">{row.createClicks}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
