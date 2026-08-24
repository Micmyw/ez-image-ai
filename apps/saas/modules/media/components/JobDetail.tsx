"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useJob } from "../hooks/use-job";
import { isEditorProductKey } from "../lib/editor-recovery";
import { getJobPresentation } from "../lib/job-status";

export function JobDetail({ jobId }: { jobId: string }) {
	const t = useTranslations("media.detail");
	const stages = useTranslations("media.status.stages");
	const products = useTranslations("media.create.products");
	const router = useRouter();
	const job = useJob(jobId);
	if (job.isError && !job.data) return <JobDetailUnavailable />;
	if (!job.data) return <div aria-busy="true">{t("loading")}</div>;
	const presentation = getJobPresentation({ status: job.data.status, progress: job.data.progress });
	const editorProductKey = isEditorProductKey(job.data.productKey) ? job.data.productKey : null;
	async function retry() {
		const result = await orpcClient.media.retryGeneration({
			jobId,
			idempotencyKey: crypto.randomUUID(),
		});
		router.push(`/create?job=${result.jobId}`);
	}
	return (
		<div>
			<Link href="/history" className="text-sm text-muted-foreground">
				← {t("back")}
			</Link>
			<div className="mt-5 p-5 md:p-8 rounded-2xl border bg-background">
				<div className="gap-3 flex flex-wrap items-center justify-between">
					<div>
						<h1 className="text-2xl font-medium">
							{editorProductKey ? products(`${editorProductKey}.label`) : t("legacyProduct")}
						</h1>
						<p className="text-xs text-muted-foreground">{job.data.id}</p>
					</div>
					<Badge status="info">{stages(presentation.stage)}</Badge>
				</div>
				<dl className="mt-8 gap-4 py-5 sm:grid-cols-3 grid border-y">
					<div>
						<dt className="text-sm text-muted-foreground">{t("reserved")}</dt>
						<dd className="font-medium">{job.data.creditsReserved}</dd>
					</div>
					<div>
						<dt className="text-sm text-muted-foreground">{t("charged")}</dt>
						<dd className="font-medium">{job.data.creditsCharged}</dd>
					</div>
					<div>
						<dt className="text-sm text-muted-foreground">{t("released")}</dt>
						<dd className="font-medium">{job.data.creditsReleased}</dd>
					</div>
				</dl>
				{presentation.stage === "failed" && (
					<p className="mt-5 p-4 text-sm rounded-xl bg-destructive/10">{t("safeFailure")}</p>
				)}
				<div className="mt-6 gap-2 flex flex-wrap">
					{editorProductKey && (
						<Button
							variant="primary"
							render={(props) => <Link {...props} href={`/create?reuseJob=${jobId}`} />}
						>
							{t("reuse")}
						</Button>
					)}
					{editorProductKey && presentation.stage === "failed" && (
						<Button variant="secondary" onClick={() => void retry()}>
							{t("retry")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

function JobDetailUnavailable() {
	const t = useTranslations("media.detail");
	return (
		<div>
			<Link href="/history" className="text-sm text-muted-foreground">
				← {t("back")}
			</Link>
			<div className="mt-5 p-5 md:p-8 rounded-2xl border bg-background">
				<h1 className="text-2xl font-medium">{t("unavailableTitle")}</h1>
				<p className="mt-2 max-w-xl text-sm text-muted-foreground">{t("unavailableDescription")}</p>
			</div>
		</div>
	);
}
