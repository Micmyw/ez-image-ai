"use client";

import {
	IMAGE_ASPECT_RATIOS,
	isTechnicalGenerationFailureCode,
	type ImageAspectRatio,
} from "@repo/config/client";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { useJob } from "../hooks/use-job";
import { isEditorProductKey } from "../lib/editor-recovery";
import { isPublicImageSkuKey } from "../lib/image-sku-selection";
import { getJobPresentation } from "../lib/job-status";
import { GenerationFailureNotice } from "./GenerationFailureNotice";
import { ModerationNotice } from "./ModerationNotice";
import { RetryGenerationButton } from "./RetryGenerationButton";

export function JobDetail({ jobId }: { jobId: string }) {
	const t = useTranslations("media.detail");
	const create = useTranslations("media.create");
	const stages = useTranslations("media.status.stages");
	const products = useTranslations("media.create.products");
	const skus = useTranslations("media.create.skus");
	const outputSettings = useTranslations("media.create.outputSettings");
	const job = useJob(jobId);
	if (job.isError && !job.data) return <JobDetailUnavailable />;
	if (!job.data) return <div aria-busy="true">{t("loading")}</div>;
	const presentation = getJobPresentation({
		...job.data,
		hasReadyOutput: job.data.assets.length > 0,
	});
	const editorProductKey = isEditorProductKey(job.data.productKey) ? job.data.productKey : null;
	const skuKey =
		editorProductKey && job.data.skuKey && isPublicImageSkuKey(job.data.skuKey)
			? job.data.skuKey
			: null;
	const aspectRatio =
		editorProductKey && isImageAspectRatio(job.data.aspectRatio) ? job.data.aspectRatio : null;
	const canReuse = Boolean(editorProductKey && skuKey && aspectRatio);
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
				<ModerationNotice job={job.data} />
				<GenerationFailureNotice job={job.data} />
				{canReuse &&
					presentation.stage === "failed" &&
					!isTechnicalGenerationFailureCode(job.data.failureReason) &&
					job.data.failureReason !== "CONTENT_NOT_ALLOWED" && (
						<p className="mt-4 text-sm text-muted-foreground">
							{create("moderationBillingPolicy")}
						</p>
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
					{canReuse && job.data.canRetry && <RetryGenerationButton key={jobId} jobId={jobId} />}
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
