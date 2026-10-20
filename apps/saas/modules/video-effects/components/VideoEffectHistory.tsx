"use client";

import { useSession } from "@auth/hooks/use-session";
import { useActiveHistoryPolling } from "@media/hooks/use-active-history-polling";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";

import { usePageVisible } from "../../video-v1/use-video";
import { videoEffectsApi } from "../lib/api";
import { videoEffectJobPath } from "../lib/paths";

export function VideoEffectHistory({
	family = "hotel-lobby",
}: {
	family?: "hotel-lobby" | "raindance" | "rumpelstiltskin";
}) {
	const { user } = useSession();
	if (!user || user.isAnonymous) return null;
	return <OwnedVideoEffectHistory key={user.id} ownerId={user.id} family={family} />;
}

function OwnedVideoEffectHistory({
	ownerId,
	family,
}: {
	ownerId: string;
	family: "hotel-lobby" | "raindance" | "rumpelstiltskin";
}) {
	const t = useTranslations("videoEffects");
	const format = useFormatter();
	const visible = usePageVisible();
	const queryKey = ["video-effects", "history", ownerId, family];
	const history = useInfiniteQuery({
		queryKey,
		queryFn: ({ pageParam, signal }) =>
			videoEffectsApi.jobs.list(
				{ limit: 20, templateFamily: family, ...(pageParam ? { cursor: pageParam } : {}) },
				{ signal },
			),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		retry: false,
	});
	useActiveHistoryPolling({
		queryKey,
		data: history.data,
		enabled: visible,
		interval: 2_500,
		getId: (item) => item.jobId,
		isActive: (item) => !["READY", "FAILED", "NEEDS_REVIEW"].includes(item.stage),
		detailKey: (id) => ["video-effects", "job", ownerId, id],
		read: (jobId, signal) => videoEffectsApi.jobs.get({ jobId }, { signal }),
		merge: (item, update) => (update.updatedAt < item.updatedAt ? item : update),
	});
	const items =
		history.data?.pages
			.flatMap((page) => page.items)
			.filter((item) => item.effectId.startsWith(family)) ?? [];
	return (
		<section id={`${family}-history`} className="ve-history" aria-labelledby="ve-history-title">
			<header className="ve-history-heading">
				<div>
					<h2 id="ve-history-title">
						{t(family === "rumpelstiltskin" ? "rumpelstiltskin.history" : "history")}
					</h2>
					<p>{t("historyHint")}</p>
				</div>
				<button
					type="button"
					className="ve-text-button"
					disabled={history.isFetching}
					onClick={() => void history.refetch()}
				>
					{t("refreshStatus")}
				</button>
			</header>
			{history.isPending && <output>{t("loading")}</output>}
			{history.isError && <p role="alert">{t("statusUnavailable")}</p>}
			{!history.isPending && !history.isError && items.length === 0 && (
				<p>{t(family === "rumpelstiltskin" ? "rumpelstiltskin.emptyHistory" : "emptyHistory")}</p>
			)}
			{items.length > 0 && (
				<ul className="ve-history-list">
					{items.map((state) => (
						<li key={state.jobId}>
							<Link
								className="ve-history-item"
								href={videoEffectJobPath(state.effectId, state.jobId)}
								prefetch={false}
							>
								<strong>
									{state.name} · {t("seconds", { seconds: state.duration ?? 5 })} ·{" "}
									{t(`stages.${state.stage}`)}
								</strong>
								<p>{t(`creditStates.${state.creditState}`, { credits: state.credits })}</p>
								<time dateTime={state.updatedAt}>
									{format.dateTime(new Date(state.updatedAt), {
										dateStyle: "medium",
										timeStyle: "short",
									})}
								</time>
							</Link>
						</li>
					))}
				</ul>
			)}
			{history.hasNextPage && (
				<button
					type="button"
					className="ve-text-button"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					{t(history.isFetchingNextPage ? "loading" : "loadMore")}
				</button>
			)}
		</section>
	);
}
