"use client";

import { useSession } from "@auth/hooks/use-session";
import { useGenerationMode } from "@media/lib/generation-mode-context";
import { Button } from "@repo/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { videoApi, type VideoState } from "./api";
import { usePageVisible, useVideoJob } from "./use-video";
import { VideoRetailPrice } from "./VideoRetailPrice";

function PrivateVideo({ jobId }: { jobId: string }) {
	const t = useTranslations("videoV1");
	const { user } = useSession();
	const pageVisible = usePageVisible();
	const active = useGenerationMode()?.mode !== "image";
	const visible = pageVisible && active;
	const video = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (!active) video.current?.pause();
	}, [active]);
	const position = useRef(0);
	const automaticRetries = useRef(0);
	const [playbackFailed, setPlaybackFailed] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [downloadFailed, setDownloadFailed] = useState(false);
	const access = useQuery({
		queryKey: ["video-v1", "playback", user?.id, jobId],
		queryFn: () => videoApi.jobs.playback({ jobId }),
		enabled: Boolean(user && !user.isAnonymous),
		retry: false,
		gcTime: 0,
		staleTime: 0,
	});
	const { data: authorization, refetch } = access;
	useEffect(() => {
		if (!authorization || !visible) return;
		const remaining = Date.parse(authorization.expiresAt) - Date.now();
		if (remaining <= 0) {
			setPlaybackFailed(true);
			return;
		}
		const timer = setTimeout(
			() => {
				position.current = video.current?.currentTime ?? 0;
				void refetch();
			},
			Math.min(remaining, 2_147_483_647),
		);
		return () => clearTimeout(timer);
	}, [authorization, refetch, visible]);
	async function refreshAccess() {
		position.current = video.current?.currentTime ?? 0;
		setPlaybackFailed(false);
		await access.refetch();
	}
	async function download() {
		setDownloading(true);
		setDownloadFailed(false);
		try {
			// Fresh authorization and server Content-Disposition; no whole-video buffering.
			const value = await videoApi.jobs.playback({ jobId, download: true });
			const anchor = document.createElement("a");
			anchor.href = value.url;
			anchor.download = `ezimage-video-${jobId}.mp4`;
			anchor.rel = "noopener";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
		} catch {
			setDownloadFailed(true);
		} finally {
			setDownloading(false);
		}
	}
	return (
		<div className="space-y-3">
			{access.data &&
				!playbackFailed &&
				!access.isError && (
					// oxlint-disable-next-line jsx-a11y/media-has-caption -- Native model audio is reviewed upstream; no transcript is supplied and fabricated captions would misrepresent it.
					<video
						key={`${access.data.url}:${access.data.expiresAt}`}
						ref={video}
						controls
						playsInline
						preload="metadata"
						src={access.data.url}
						className="bg-black max-h-[65vh] w-full rounded-xl"
						aria-label={t("player")}
						onLoadedMetadata={() => {
							if (video.current && position.current > 0)
								video.current.currentTime = Math.min(
									position.current,
									video.current.duration || position.current,
								);
						}}
						onError={() => {
							if (automaticRetries.current++ < 1) void refreshAccess();
							else setPlaybackFailed(true);
						}}
					/>
				)}
			{access.isPending && <output>{t("loadingPlayback")}</output>}
			{(playbackFailed || access.isError) && (
				<div role="alert" className="space-y-2">
					<p>{t("playbackExpired")}</p>
					<Button
						variant="secondary"
						onClick={() => {
							automaticRetries.current = 0;
							void refreshAccess();
						}}
						disabled={access.isFetching}
					>
						{t("refreshPlayback")}
					</Button>
				</div>
			)}
			<Button onClick={download} disabled={downloading}>
				<DownloadIcon aria-hidden className="size-4" />
				{t(downloading ? "downloading" : "download")}
			</Button>
			{downloadFailed && <p role="alert">{t("downloadFailed")}</p>}
		</div>
	);
}

export function VideoStateCard({ state }: { state: VideoState }) {
	const t = useTranslations("videoV1");
	return (
		<section
			className="space-y-4 p-5 rounded-2xl border"
			aria-label={t("job")}
			data-test="video-job"
			data-stage={state.stage}
		>
			<div aria-live="polite" aria-atomic="true" className="space-y-2">
				<h2 className="text-lg font-semibold">{t(`stages.${state.stage}`)}</h2>
				<p className="text-sm text-muted-foreground">{t(`stageDescriptions.${state.stage}`)}</p>
				<p className="text-sm font-medium">
					{t(`credits.${state.creditState}`, { credits: state.credits })}
				</p>
			</div>
			<p className="text-xs break-all text-muted-foreground">{t("jobId", { id: state.jobId })}</p>
			{state.creditState !== "RELEASED" && state.pricing?.audience === "annual" && (
				<VideoRetailPrice pricing={state.pricing} />
			)}
			{state.canPlay && state.stage === "READY" && (
				<PrivateVideo key={state.jobId} jobId={state.jobId} />
			)}
		</section>
	);
}

export function VideoJob({ jobId }: { jobId: string }) {
	const t = useTranslations("videoV1");
	const job = useVideoJob(jobId);
	return (
		<div className="space-y-3">
			{job.isPending && <output>{t("loadingJob")}</output>}
			{job.isError && (
				<div role="alert" className="space-y-2 p-4 rounded-xl border">
					<p>{t("jobUnavailable")}</p>
					<Button variant="secondary" disabled={job.isFetching} onClick={() => void job.refetch()}>
						<RefreshCwIcon aria-hidden className="size-4" />
						{t("refreshStatus")}
					</Button>
				</div>
			)}
			{job.data && <VideoStateCard state={job.data} />}
		</div>
	);
}
