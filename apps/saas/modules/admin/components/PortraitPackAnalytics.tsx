"use client";

import type { ConversionFunnel } from "@repo/api/modules/admin-analytics/conversion-types";
import { useFormatter, useTranslations } from "next-intl";

export function PortraitPackAnalytics({ rows }: { rows: ConversionFunnel["portraitPacks"] }) {
	const t = useTranslations("admin.conversion.portraitPacks");
	const format = useFormatter();
	return (
		<section className="space-y-3 p-4 rounded-lg border">
			<h3 className="font-medium">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t("basis")}</p>
			<div className="overflow-x-auto">
				<table className="text-sm w-full text-left">
					<caption className="sr-only">{t("title")}</caption>
					<thead>
						<tr className="border-b">
							{(["placement", "cta", "exposed", "clicked", "rate"] as const).map((key) => (
								<th scope="col" className="p-2 whitespace-nowrap" key={key}>
									{t(key)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map(({ placement, cta, exposed, clicked }) => (
							<tr className="border-b" key={`${placement}:${cta}`}>
								<th scope="row" className="p-2 font-normal">
									{t(`placements.${placement}`)}
								</th>
								<td className="p-2">{t(`ctas.${cta}`)}</td>
								<td className="p-2 tabular-nums">{exposed}</td>
								<td className="p-2 tabular-nums">{clicked}</td>
								<td className="p-2 tabular-nums">
									{exposed
										? format.number(clicked / exposed, {
												style: "percent",
												maximumFractionDigits: 1,
											})
										: "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
