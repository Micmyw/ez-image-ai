"use client";

import { useSession } from "@auth/hooks/use-session";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, FilmIcon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { usePageVisible } from "../../video-v1/use-video";
import { VideoOutputDetails } from "../../video-v1/VideoOutputDetails";
import { recordVideoEffectEvent } from "../lib/analytics";
import { videoEffectsApi, type VideoEffectState } from "../lib/api";

export function VideoEffectJob({ jobId }: { jobId: string }) {
	const t = useTranslations("videoEffects");
	const outputText = useTranslations("videoV1.output");
	const { user } = useSession();
	const visible = usePageVisible();
	const state = useQuery({
		queryKey: ["video-effects", "job", user?.id, jobId],
		queryFn: () => videoEffectsApi.jobs.get({ jobId }),
		enabled: Boolean(user && !user.isAnonymous),
		retry: false,
		refetchInterval: (query) =>
			visible && !["READY", "FAILED", "NEEDS_REVIEW"].includes(query.state.data?.stage ?? "")
				? 2500
				: false,
		refetchIntervalInBackground: false,
	});
	useEffect(() => {
		const stage = state.data?.stage;
		if (stage === "READY" || stage === "FAILED" || stage === "NEEDS_REVIEW")
			void recordVideoEffectEvent(
				stage === "READY" ? "ready" : stage === "FAILED" ? "failed" : "held",
				jobId,
				state.data?.effectId,
			);
	}, [state.data?.stage, state.data?.effectId, jobId]);
	return (
		<section className="ve-result" aria-live="polite" aria-label={t("yourVideo")}>
			<div className="ve-result-heading">
				<span className="ve-eyebrow">{t("yourVideo")}</span>
				<FilmIcon aria-hidden />
			</div>
			{state.data ? (
				<>
					<h2>{t(`stages.${state.data.stage}`)}</h2>
					{state.data.output ? (
						<VideoOutputDetails output={state.data.output} />
					) : (
						<p>
							{outputText("requested", {
								seconds: state.data.duration ?? 5,
								resolution: "720p",
								ratio: "9:16",
								audio: outputText("withoutAudio"),
							})}
						</p>
					)}
					<p>{t(`creditStates.${state.data.creditState}`, { credits: state.data.credits })}</p>
					{state.data.canPlay && state.data.stage === "READY" ? (
						<PrivateEffectVideo state={state.data} />
					) : (
						<div className="ve-progress">
							<FilmIcon aria-hidden />
							<p>
								{t(
									state.data.stage === "NEEDS_REVIEW"
										? "heldHint"
										: state.data.stage === "FAILED"
											? "failedHint"
											: "canLeave",
								)}
							</p>
						</div>
					)}
				</>
			) : (
				<p>{t(state.isError ? "statusUnavailable" : "loading")}</p>
			)}
			<button
				type="button"
				className="ve-text-button"
				onClick={() => void state.refetch()}
				disabled={state.isFetching}
			>
				<RefreshCwIcon aria-hidden />
				{t("refreshStatus")}
			</button>
		</section>
	);
}

function PrivateEffectVideo({ state }: { state: VideoEffectState }) {
	const t = useTranslations("videoEffects");
	const { user } = useSession();
	const video = useRef<HTMLVideoElement>(null);
	const position = useRef(0);
	const [failed, setFailed] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const playback = useQuery({
		queryKey: ["video-effects", "playback", user?.id, state.jobId],
		queryFn: () => videoEffectsApi.jobs.playback({ jobId: state.jobId }),
		retry: false,
		gcTime: 0,
		staleTime: 0,
	});
	const { data, refetch } = playback;
	useEffect(() => {
		if (!data) return;
		const delay = Date.parse(data.expiresAt) - Date.now();
		if (delay <= 0) {
			setFailed(true);
			return;
		}
		const timer = setTimeout(
			() => {
				position.current = video.current?.currentTime ?? 0;
				void refetch();
			},
			Math.min(delay, 2_147_483_647),
		);
		return () => clearTimeout(timer);
	}, [data, refetch]);
	async function download() {
		setDownloading(true);
		try {
			const authorization = await videoEffectsApi.jobs.playback({
				jobId: state.jobId,
				download: true,
			});
			const anchor = document.createElement("a");
			anchor.href = authorization.url;
			anchor.download = `${state.effectId}.mp4`;
			anchor.rel = "noopener";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			void recordVideoEffectEvent("download", undefined, state.effectId);
		} catch {
			setFailed(true);
		} finally {
			setDownloading(false);
		}
	}
	return (
		<div className="ve-private-video">
			{data && !failed && !playback.isError && (
				<video
					ref={video}
					controls
					playsInline
					preload="metadata"
					src={data.url}
					aria-label={t("yourVideo")}
					onLoadedMetadata={() => {
						if (video.current)
							video.current.currentTime = Math.min(position.current, video.current.duration || 0);
					}}
					onError={() => setFailed(true)}
				>
					<track kind="captions" />
				</video>
			)}
			{(failed || playback.isError) && (
				<div role="alert">
					<p>{t("playbackExpired")}</p>
					<button
						type="button"
						className="ve-secondary"
						onClick={() => {
							setFailed(false);
							void refetch();
						}}
					>
						{t("refreshStatus")}
					</button>
				</div>
			)}
			<button
				type="button"
				className="ve-primary"
				disabled={downloading}
				onClick={() => void download()}
			>
				<DownloadIcon aria-hidden />
				{t("download")}
			</button>
		</div>
	);
}
