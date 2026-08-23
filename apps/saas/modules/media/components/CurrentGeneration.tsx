"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Progress } from "@repo/ui/components/progress";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { useJob } from "../hooks/use-job";
import { getJobPresentation } from "../lib/job-status";

export function CurrentGeneration({ jobId, onNew }: { jobId: string | null; onNew: () => void }) {
	const t = useTranslations("media.status");
	const job = useJob(jobId);
	if (!jobId)
		return (
			<div className="min-h-80 p-8 flex flex-col items-center justify-center rounded-2xl border border-dashed text-center">
				<div
					className="mb-4 size-12 motion-safe:animate-spin rounded-full border-4 border-muted border-t-primary motion-reduce:border-primary"
					aria-hidden
				/>
				<h2 className="font-medium text-xl">{t("emptyTitle")}</h2>
				<p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("emptyDescription")}</p>
			</div>
		);
	if (!job.data)
		return (
			<div className="min-h-80 p-8 rounded-2xl border" aria-busy="true">
				{t("loading")}
			</div>
		);
	const presentation = getJobPresentation({ status: job.data.status, progress: job.data.progress });
	return (
		<section className="min-h-80 p-6 rounded-2xl border bg-background" aria-live="polite">
			<div className="flex items-center justify-between">
				<Badge status="info">{t(`stages.${presentation.stage}`)}</Badge>
				<span className="text-xs text-muted-foreground">{job.data.id}</span>
			</div>
			<h2 className="mt-8 text-2xl font-medium">{t(`headings.${presentation.stage}`)}</h2>
			{presentation.progress !== null && (
				<div className="mt-6">
					<Progress
						value={presentation.progress}
						aria-label={t("progress", { progress: presentation.progress })}
					/>
					<p className="mt-2 text-sm text-right tabular-nums">{presentation.progress}%</p>
				</div>
			)}
			<div className="mt-8 gap-2 py-4 text-sm grid grid-cols-3 border-y text-center">
				<div>
					<strong className="block">{job.data.creditsReserved}</strong>
					{t("reserved")}
				</div>
				<div>
					<strong className="block">{job.data.creditsCharged}</strong>
					{t("charged")}
				</div>
				<div>
					<strong className="block">{job.data.creditsReleased}</strong>
					{t("released")}
				</div>
			</div>
			{job.data.assets.length > 0 && (
				<div className="mt-6 gap-3 grid grid-cols-2">
					{job.data.assets.map((asset) => (
						<AssetPreview key={asset.id} assetId={asset.id} mimeType={asset.mimeType} />
					))}
				</div>
			)}
			<div className="mt-6 gap-2 flex flex-wrap">
				{!presentation.terminal && (
					<Button
						variant="secondary"
						onClick={() =>
							void orpcClient.media.cancelGeneration({ jobId }).then(() => job.refetch())
						}
					>
						{t("cancel")}
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

function AssetPreview({ assetId, mimeType }: { assetId: string; mimeType: string }) {
	const t = useTranslations("media.assets");
	const preview = useQuery({
		queryKey: ["media-asset-preview", assetId],
		queryFn: () => orpcClient.media.getAssetAccessUrl({ assetId, disposition: "inline" }),
		staleTime: 4 * 60_000,
	});
	const content = (
		<>
			{preview.data ? (
				mimeType.startsWith("image/") ? (
					<img src={preview.data.url} alt="" className="size-full object-cover" />
				) : (
					<video
						src={preview.data.url}
						muted
						playsInline
						aria-label={t("preview")}
						className="size-full object-cover"
					>
						<track kind="captions" />
					</video>
				)
			) : (
				<span className="text-sm flex size-full items-center justify-center text-muted-foreground">
					…
				</span>
			)}
		</>
	);
	const className =
		"aspect-video overflow-hidden rounded-xl border bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
	return mimeType.startsWith("image/") ? (
		<Link href={`/create?asset=${encodeURIComponent(assetId)}`} className={className}>
			{content}
		</Link>
	) : (
		<div className={className}>{content}</div>
	);
}
