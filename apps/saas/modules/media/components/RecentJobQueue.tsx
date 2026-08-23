"use client";

import { Badge } from "@repo/ui/components/badge";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { useJobHistory } from "../hooks/use-job-history";
import { getJobPresentation } from "../lib/job-status";

export function RecentJobQueue({
	selectedJobId,
	onSelect,
}: {
	selectedJobId: string | null;
	onSelect: (id: string) => void;
}) {
	const t = useTranslations("media.status");
	const history = useJobHistory({});
	const jobs = history.data?.pages.flatMap((page) => page.items).slice(0, 8) ?? [];
	if (!jobs.length) return null;
	return (
		<div className="mt-5 pb-2 overflow-x-auto" aria-label={t("recent")}>
			<div className="gap-2 flex min-w-max">
				{jobs.map((job) => {
					const stage = getJobPresentation({ status: job.status }).stage;
					return (
						<button
							key={job.id}
							type="button"
							onClick={() => onSelect(job.id)}
							className={`min-w-48 p-3 rounded-xl border text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${selectedJobId === job.id ? "border-primary bg-primary/10" : "bg-background"}`}
						>
							<div className="gap-2 flex items-center justify-between">
								<span className="font-medium text-sm">{job.productKey}</span>
								<Badge status="info">{t(`stages.${stage}`)}</Badge>
							</div>
							<span className="mt-2 text-xs block text-muted-foreground">
								{new Date(job.createdAt).toLocaleString()}
							</span>
						</button>
					);
				})}
				<Link
					href="/history"
					className="min-w-32 px-4 text-sm flex items-center justify-center rounded-xl border"
				>
					{t("all")}
				</Link>
			</div>
		</div>
	);
}
