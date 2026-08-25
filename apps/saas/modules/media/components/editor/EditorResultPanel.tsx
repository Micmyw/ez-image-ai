"use client";

import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Progress } from "@repo/ui/components/progress";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { useJob } from "../../hooks/use-job";
import { isEditorProductKey } from "../../lib/editor-recovery";
import { getSignedComparisonState, requestPrivateDownload } from "../../lib/editor-result";
import { getJobPresentation } from "../../lib/job-status";
import { BeforeAfterSlider } from "./BeforeAfterSlider";

export function EditorResultPanel({ jobId, onNew }: { jobId: string | null; onNew: () => void }) {
	const t = useTranslations("media.status");
	const job = useJob(jobId);
	const [canceling, setCanceling] = useState(false);
	const [cancelError, setCancelError] = useState(false);

	if (!jobId) return <EditorEmptyState />;
	if (job.isError && !job.data) return <EditorUnavailableState />;
	if (!job.data) {
		return (
			<div className="min-h-80 p-8 rounded-2xl border" aria-busy="true">
				<p className="text-sm text-muted-foreground">{t("loading")}</p>
			</div>
		);
	}
	if (
		!isEditorProductKey(job.data.productKey) ||
		job.data.inputAssets.length === 0 ||
		!job.data.inputAssets.every((asset) => asset.mimeType.startsWith("image/")) ||
		!job.data.assets.every((asset) => asset.mimeType.startsWith("image/"))
	) {
		return <EditorUnavailableState detailsHref={`/history/${jobId}`} />;
	}

	const presentation = getJobPresentation({ status: job.data.status, progress: job.data.progress });
	const source = job.data.inputAssets[0];
	const output = job.data.assets[0];

	async function cancel() {
		if (!jobId) return;
		setCancelError(false);
		setCanceling(true);
		try {
			await orpcClient.media.cancelGeneration({ jobId });
			await job.refetch();
		} catch {
			setCancelError(true);
		} finally {
			setCanceling(false);
		}
	}

	return (
		<section className="min-h-80 p-5 md:p-6 rounded-2xl border bg-background" aria-live="polite">
			<div className="gap-3 flex flex-wrap items-center justify-between">
				<Badge status="info">{t(`stages.${presentation.stage}`)}</Badge>
				<span className="text-xs text-muted-foreground">{job.data.id}</span>
			</div>
			<h2 className="mt-6 text-2xl font-medium">{t(`headings.${presentation.stage}`)}</h2>
			{presentation.progress !== null && (
				<div className="mt-6">
					<Progress
						value={presentation.progress}
						aria-label={t("progress", { progress: presentation.progress })}
					/>
					<p className="mt-2 text-sm text-right tabular-nums">{presentation.progress}%</p>
				</div>
			)}
			<p className="mt-5 p-3 text-sm rounded-xl bg-muted/40">{creditSummary(t, job.data)}</p>
			{job.data.failureReason === "CONTENT_NOT_ALLOWED" && (
				<Alert className="mt-5" variant="error">
					<AlertDescription>{t("moderationRejected")}</AlertDescription>
				</Alert>
			)}
			{job.data.status === "FAILED" && job.data.failureReason !== "CONTENT_NOT_ALLOWED" && (
				<p className="mt-4 text-sm text-muted-foreground">{t("failureHelp")}</p>
			)}
			{job.data.status === "SUCCEEDED" && source && output && (
				<div className="mt-6">
					<SignedComparison inputAssetId={source.id} outputAssetId={output.id} />
				</div>
			)}
			{job.data.status === "SUCCEEDED" && (!source || !output) && (
				<Alert className="mt-5" variant="error">
					<AlertDescription>{t("comparisonUnavailable")}</AlertDescription>
				</Alert>
			)}
			{cancelError && (
				<Alert className="mt-5" variant="error">
					<AlertDescription>{t("cancelUnavailable")}</AlertDescription>
				</Alert>
			)}
			<div className="mt-6 gap-2 flex flex-wrap">
				{job.data.canCancel && (
					<Button variant="secondary" loading={canceling} disabled={canceling} onClick={cancel}>
						{t("cancel")}
					</Button>
				)}
				{job.data.status === "SUCCEEDED" && output && <DownloadButton assetId={output.id} />}
				{job.data.status === "SUCCEEDED" && output && (
					<Button
						variant="secondary"
						render={(props) => (
							<a
								{...props}
								href={`/create?asset=${encodeURIComponent(output.id)}&parentJob=${encodeURIComponent(jobId)}`}
							>
								{props.children}
							</a>
						)}
					>
						{t("editAgain")}
					</Button>
				)}
				<Button variant="ghost" onClick={onNew}>
					{t("new")}
				</Button>
				<Button variant="ghost" render={(props) => <Link {...props} href={`/history/${jobId}`} />}>
					{t("details")}
				</Button>
			</div>
		</section>
	);
}

function EditorUnavailableState({ detailsHref }: { detailsHref?: string }) {
	const t = useTranslations("media.status");
	return (
		<section className="min-h-80 p-6 md:p-8 flex flex-col items-center justify-center rounded-2xl border border-dashed text-center">
			<h2 className="font-medium text-xl">{t("unavailableTitle")}</h2>
			<p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("unavailableDescription")}</p>
			{detailsHref && (
				<Button
					className="mt-5"
					variant="ghost"
					render={(props) => <Link {...props} href={detailsHref} />}
				>
					{t("details")}
				</Button>
			)}
		</section>
	);
}

function EditorEmptyState() {
	const t = useTranslations("media.status");
	return (
		<div className="min-h-80 p-6 md:p-8 flex flex-col items-center justify-center rounded-2xl border border-dashed text-center">
			<div className="mb-5 gap-2 grid grid-cols-2" aria-hidden="true">
				<div className="size-20 rounded-xl bg-gradient-to-br from-muted to-muted/40" />
				<div className="size-20 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5" />
			</div>
			<h2 className="font-medium text-xl">{t("emptyTitle")}</h2>
			<p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("emptyDescription")}</p>
		</div>
	);
}

function SignedComparison({
	inputAssetId,
	outputAssetId,
}: {
	inputAssetId: string;
	outputAssetId: string;
}) {
	const t = useTranslations("media.status");
	const input = useQuery({
		queryKey: ["media-asset-preview", inputAssetId],
		queryFn: () =>
			orpcClient.media.getAssetAccessUrl({ assetId: inputAssetId, disposition: "inline" }),
		staleTime: 4 * 60_000,
	});
	const output = useQuery({
		queryKey: ["media-asset-preview", outputAssetId],
		queryFn: () =>
			orpcClient.media.getAssetAccessUrl({ assetId: outputAssetId, disposition: "inline" }),
		staleTime: 4 * 60_000,
	});
	const state = getSignedComparisonState(input, output);
	if (state === "unavailable") {
		return (
			<Alert variant="error">
				<AlertDescription>{t("comparisonUnavailable")}</AlertDescription>
			</Alert>
		);
	}
	if (state === "loading" || !input.data || !output.data) {
		return (
			<p className="p-5 text-sm rounded-xl border text-muted-foreground">{t("compare.loading")}</p>
		);
	}
	return (
		<BeforeAfterSlider
			beforeUrl={input.data.url}
			afterUrl={output.data.url}
			beforeAlt={t("compare.beforeAlt")}
			afterAlt={t("compare.afterAlt")}
			controlLabel={t("compare.control")}
			showOriginalLabel={t("compare.showOriginal")}
			showResultLabel={t("compare.showResult")}
			beforeLabel={t("compare.before")}
			afterLabel={t("compare.after")}
		/>
	);
}

function DownloadButton({ assetId }: { assetId: string }) {
	const t = useTranslations("media.status");
	const [downloading, setDownloading] = useState(false);
	const [downloadError, setDownloadError] = useState(false);
	async function download() {
		setDownloadError(false);
		setDownloading(true);
		try {
			const downloaded = await requestPrivateDownload(assetId, {
				getAccessUrl: (requestedAssetId) =>
					orpcClient.media.getAssetAccessUrl({
						assetId: requestedAssetId,
						disposition: "attachment",
					}),
				navigate: (url) => window.location.assign(url),
			});
			setDownloadError(!downloaded);
		} finally {
			setDownloading(false);
		}
	}
	return (
		<>
			<Button variant="primary" loading={downloading} disabled={downloading} onClick={download}>
				{t("download")}
			</Button>
			{downloadError && (
				<span className="text-sm text-destructive" role="alert">
					{t("downloadUnavailable")}
				</span>
			)}
		</>
	);
}

function creditSummary(
	t: ReturnType<typeof useTranslations>,
	job: {
		status: string;
		creditsReserved: string;
		creditsCharged: string;
		creditsReleased: string;
	},
) {
	if (job.status === "SUCCEEDED") {
		return t("creditSummarySucceeded", {
			charged: job.creditsCharged,
			released: job.creditsReleased,
		});
	}
	if (job.status === "FAILED" || job.status === "CANCELED") {
		return t("creditSummaryReturned", {
			reserved: job.creditsReserved,
			released: job.creditsReleased,
		});
	}
	return t("creditSummaryReserved", { reserved: job.creditsReserved });
}
