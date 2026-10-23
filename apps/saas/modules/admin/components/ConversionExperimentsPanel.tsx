"use client";

import type { ConversionFunnel } from "@repo/api/modules/admin-analytics/conversion-types";
import { useTranslations } from "next-intl";

const experimentColumns = [
	"exposed",
	"clicked",
	"purchaseClicked",
	"linked",
	"ambiguous",
	"checkouts",
	"paid",
	"ctr",
	"paymentRate",
	"mature",
	"matureRate",
] as const;
const activityColumns = [
	"attemptedUsers",
	"jobs",
	"succeeded",
	"failed",
	"resultViewers",
	"downloaders",
	"purchaseClicked",
	"latencySamples",
	"checkouts",
	"paid",
	"p50Ms",
	"p90Ms",
] as const;
const rate = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

export function ConversionExperimentsPanel({ data }: { data: ConversionFunnel }) {
	const t = useTranslations("admin.conversion.experimentReport");
	return (
		<>
			<h3 className="font-medium">{t("activityTitle")}</h3>
			<p className="text-sm text-muted-foreground">{t("activityBasis")}</p>
			<div className="overflow-x-auto">
				<table className="text-sm w-full text-left">
					<thead>
						<tr>
							<th className="p-2">{t("cohort")}</th>
							{activityColumns.map((key) => (
								<th className="p-2" key={key}>
									{t(key)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.activity.map((row) => (
							<tr key={row.cohort} className="border-b">
								<th className="p-2">{t(row.cohort)}</th>
								{activityColumns.map((key) => (
									<td className="p-2" key={key}>
										{key === "p50Ms" || key === "p90Ms"
											? row[key] === null
												? "—"
												: `${(row[key]! / 1000).toFixed(1)} s`
											: row[key]}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<h3 className="font-medium">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t("basis")}</p>
			{data.experiments.map((experiment) => (
				<section key={experiment.experimentId} className="space-y-2">
					<h4 className="font-medium">{t(experiment.experimentId)}</h4>
					<div className="overflow-x-auto">
						<table className="text-sm w-full text-left">
							<thead>
								<tr>
									<th className="p-2">{t("variant")}</th>
									{experimentColumns.map((key) => (
										<th className="p-2" key={key}>
											{t(key)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{experiment.variants.map((row) => (
									<tr key={row.variant} className="border-b">
										<th className="p-2">{t(row.variant as "annual")}</th>
										{experimentColumns.map((key) => (
											<td className="p-2" key={key}>
												{key === "ctr"
													? rate(row.clicked, row.exposed)
													: key === "paymentRate"
														? rate(row.paid, row.exposed)
														: key === "matureRate"
															? rate(row.maturePaid, row.mature)
															: row[key]}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			))}
			<p className="text-sm text-muted-foreground">{t("interpretation")}</p>
		</>
	);
}
