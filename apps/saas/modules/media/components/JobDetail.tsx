"use client";

import { IMAGE_ASPECT_RATIOS, type ImageAspectRatio } from "@repo/config/client";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useJob } from "../hooks/use-job";
import { isEditorProductKey } from "../lib/editor-recovery";
import { isPublicImageSkuKey } from "../lib/image-sku-selection";
import { getJobPresentation } from "../lib/job-status";

export function JobDetail({ jobId }: { jobId: string }) {
	const t = useTranslations("media.detail");
	const stages = useTranslations("media.status.stages");
	const products = useTranslations("media.create.products");
	const skus = useTranslations("media.create.skus");
	const outputSettings = useTranslations("media.create.outputSettings");
	const router = useRouter();
	const job = useJob(jobId);
	if (job.isError && !job.data) return <JobDetailUnavailable />;
	if (!job.data) return <div aria-busy="true">{t("loading")}</div>;
	const presentation = getJobPresentation({ status: job.data.status, progress: job.data.progress });
	const editorProductKey = isEditorProductKey(job.data.productKey) ? job.data.productKey : null;
	const skuKey =
		editorProductKey && job.data.skuKey && isPublicImageSkuKey(job.data.skuKey)
			? job.data.skuKey
			: null;
	const aspectRatio =
		editorProductKey && isImageAspectRatio(job.data.aspectRatio) ? job.data.aspectRatio : null;
	const canReuse = Boolean(editorProductKey && skuKey && aspectRatio);
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
						{skuKey && aspectRatio && (
							<p className="mt-1 text-sm text-muted-foreground">
								{skus(`${skuKey}.label`)} ·{" "}
								{aspectRatio === "auto" ? outputSettings("automatic") : aspectRatio}
							</p>
						)}
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
					{canReuse && (
						<Button
							variant="primary"
							render={(props) => <Link {...props} href={`/create?reuseJob=${jobId}`} />}
						>
							{t("reuse")}
						</Button>
					)}
					{canReuse && presentation.stage === "failed" && (
						<Button variant="secondary" onClick={() => void retry()}>
							{t("retry")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

function isImageAspectRatio(value: string | null | undefined): value is ImageAspectRatio {
	return Boolean(value && IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio));
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
