"use client";

import { schedulePrivatePlaybackRefresh } from "@media/lib/private-playback-refresh";
import type { SourceTemplateKey } from "@repo/config/video-template-library";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { usePageVisible } from "../../video-v1/use-video";
import { VideoOutputDetails } from "../../video-v1/VideoOutputDetails";
import { videoTemplatesApi } from "../lib/api";

const terminal = ["READY", "FAILED", "REJECTED", "NEEDS_REVIEW"];
const stageKeys = [
	"QUEUED",
	"REVIEWING_INPUT",
	"GENERATING",
	"TRANSFERRING",
	"REVIEWING_OUTPUT",
	"READY",
	"FAILED",
	"NEEDS_REVIEW",
	"SUBMITTED",
	"SUBMITTING",
	"SUBMISSION_UNCERTAIN",
	"PENDING",
] as const;
type StageKey = (typeof stageKeys)[number];
function stageKey(stage: string): StageKey {
	const aliases: Record<string, StageKey> = {
		INPUT_REVIEW: "REVIEWING_INPUT",
		OUTPUT_REVIEW: "REVIEWING_OUTPUT",
		STORING: "TRANSFERRING",
		REJECTED: "FAILED",
		FINALIZING: "TRANSFERRING",
	};
	if (aliases[stage]) return aliases[stage];
	return stageKeys.includes(stage as StageKey) ? (stage as StageKey) : "PENDING";
}

export function TemplateJob({ ownerId, jobId }: { ownerId: string; jobId: string }) {
	const t = useTranslations("videoTemplates");
	const visible = usePageVisible();
	const state = useQuery({
		queryKey: ["video-templates", "job", ownerId, jobId],
		queryFn: ({ signal }) => videoTemplatesApi.jobs.get({ jobId }, { signal }),
		retry: false,
		refetchInterval: (query) =>
			visible && !terminal.includes(query.state.data?.stage ?? "") ? 2000 : false,
		refetchIntervalInBackground: false,
	});
	return (
		<section className="vt-result" aria-label={t("result")} aria-live="polite">
			<span className="vt-eyebrow">{t("result")}</span>
			<h2>
				{state.data
					? t(`stage.${stageKey(state.data.stage)}`)
					: t(state.isError ? "requestFailed" : "loading")}
			</h2>
			{state.data && (
				<>
					<p>{t(`creditState.${state.data.creditState}`, { credits: state.data.credits })}</p>
					{state.data.output && <VideoOutputDetails output={state.data.output} />}
					{state.data.canPlay && state.data.stage === "READY" ? (
						<TemplatePlayback ownerId={ownerId} jobId={jobId} />
					) : (
						<p className="vt-help">
							{t(
								state.data.stage === "NEEDS_REVIEW"
									? "held"
									: state.data.stage === "FAILED"
										? "failed"
										: "inProgress",
							)}
						</p>
					)}
				</>
			)}
			<button
				type="button"
				className="vt-text-button"
				disabled={state.isFetching}
				onClick={() => void state.refetch()}
			>
				<RefreshCwIcon aria-hidden />
				{t("refresh")}
			</button>
		</section>
	);
}
function TemplatePlayback({ ownerId, jobId }: { ownerId: string; jobId: string }) {
	const t = useTranslations("videoTemplates");
	const visible = usePageVisible();
	const video = useRef<HTMLVideoElement>(null);
	const position = useRef(0);
	const [failed, setFailed] = useState(false);
	const [downloadFailed, setDownloadFailed] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const access = useQuery({
		queryKey: ["video-templates", "playback", ownerId, jobId],
		queryFn: ({ signal }) => videoTemplatesApi.jobs.playback({ jobId }, { signal }),
		enabled: visible,
		retry: false,
		gcTime: 0,
		staleTime: 0,
	});
	const { data, refetch } = access;
	useEffect(() => {
		if (!visible) video.current?.pause();
	}, [visible]);
	useEffect(
		() =>
			schedulePrivatePlaybackRefresh(data?.expiresAt, visible, () => {
				position.current = video.current?.currentTime ?? 0;
				void refetch({ cancelRefetch: false }).then((result) => {
					if (!result.isError) setFailed(false);
				});
			}),
		[data?.expiresAt, refetch, visible],
	);
	async function download() {
		setDownloading(true);
		setDownloadFailed(false);
		try {
			const authorization = await videoTemplatesApi.jobs.playback({ jobId, download: true });
			const anchor = document.createElement("a");
			anchor.href = authorization.url;
			anchor.download = `ezpic-template-${jobId}.mp4`;
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
		<div className="vt-playback">
			{data && !failed && !access.isError ? (
				<>
					{/* No transcript is provided with original template sound. */}
					{/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
					<video
						ref={video}
						key={data.url}
						src={data.url}
						controls
						playsInline
						preload="metadata"
						data-clarity-mask="true"
						onError={() => setFailed(true)}
						onLoadedMetadata={() => {
							if (video.current) video.current.currentTime = position.current;
						}}
					/>
				</>
			) : (
				<p>{t(failed || access.isError ? "playbackFailed" : "loading")}</p>
			)}
			{(failed || access.isError) && (
				<button
					type="button"
					onClick={() =>
						void refetch().then((result) => {
							if (!result.isError) setFailed(false);
						})
					}
				>
					{t("retry")}
				</button>
			)}
			<button
				type="button"
				className="vt-primary"
				disabled={downloading}
				onClick={() => void download()}
			>
				<DownloadIcon aria-hidden />
				{t("download")}
			</button>
			{downloadFailed && <p role="alert">{t("downloadFailed")}</p>}
		</div>
	);
}
export function TemplateHistory({
	ownerId,
	templateKey,
	onSelect,
}: {
	ownerId: string;
	templateKey: SourceTemplateKey;
	onSelect: (jobId: string) => void;
}) {
	const t = useTranslations("videoTemplates");
	const format = useFormatter();
	const visible = usePageVisible();
	const history = useInfiniteQuery({
		queryKey: ["video-templates", "history", ownerId, templateKey],
		queryFn: ({ pageParam, signal }) =>
			videoTemplatesApi.jobs.list(
				{ templateKey, limit: 12, ...(pageParam ? { cursor: pageParam } : {}) },
				{ signal },
			),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		retry: false,
		refetchInterval: (query) =>
			visible &&
			query.state.data?.pages.some((page) =>
				page.items.some((item) => !terminal.includes(item.stage)),
			)
				? 5000
				: false,
		refetchIntervalInBackground: false,
	});
	const items = history.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<section id="template-history" className="vt-history">
			<header className="vt-section-heading">
				<h2>{t("history")}</h2>
				<button type="button" disabled={history.isFetching} onClick={() => void history.refetch()}>
					{t("refresh")}
				</button>
			</header>
			{history.isPending ? (
				<p>{t("loading")}</p>
			) : history.isError ? (
				<p role="alert">{t("historyFailed")}</p>
			) : items.length === 0 ? (
				<p>{t("historyEmpty")}</p>
			) : (
				<ul>
					{items.map((item) => (
						<li key={item.jobId}>
							<button type="button" onClick={() => onSelect(item.jobId)}>
								<strong>{t(`stage.${stageKey(item.stage)}`)}</strong>
								<span>{t("credits", { credits: item.credits })}</span>
								<time dateTime={item.updatedAt}>
									{format.dateTime(new Date(item.updatedAt), {
										dateStyle: "medium",
										timeStyle: "short",
									})}
								</time>
							</button>
						</li>
					))}
				</ul>
			)}
			{history.hasNextPage && (
				<button
					type="button"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					{t("more")}
				</button>
			)}
		</section>
	);
}
