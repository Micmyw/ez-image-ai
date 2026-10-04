"use client";

import { useSession } from "@auth/hooks/use-session";
import { Button } from "@repo/ui/components/button";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { videoApi } from "./api";
import { videoPollInterval } from "./model";
import { usePageVisible } from "./use-video";

export function VideoHistory() {
	const t = useTranslations("videoV1");
	const { user } = useSession();
	const visible = usePageVisible();
	const history = useInfiniteQuery({
		queryKey: ["video-v1", "history", user?.id],
		queryFn: ({ pageParam }) =>
			videoApi.jobs.list({ limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: Boolean(user && !user.isAnonymous),
		retry: false,
		refetchInterval: (query) =>
			visible &&
			query.state.data?.pages.some((page) =>
				page.items.some((item) => videoPollInterval(item.stage, true)),
			)
				? 2000
				: false,
		refetchIntervalInBackground: false,
	});
	const items = history.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<div className="max-w-5xl space-y-6 mx-auto" data-test="video-history">
			<header className="gap-4 flex flex-wrap items-center justify-between">
				<div className="space-y-2">
					<h1 className="text-3xl font-semibold">{t("history")}</h1>
					<p className="text-sm text-muted-foreground">{t("historyHint")}</p>
				</div>
				<Button render={(props) => <Link {...props} href="/video" />}>{t("newVideo")}</Button>
			</header>
			{history.isPending && <output>{t("loadingJob")}</output>}
			{history.isError && <p role="alert">{t("jobUnavailable")}</p>}
			<Button
				variant="secondary"
				disabled={history.isFetching}
				onClick={() => void history.refetch()}
			>
				{t("refreshStatus")}
			</Button>
			{!history.isPending && !history.isError && items.length === 0 && (
				<p className="p-8 rounded-xl border border-dashed text-center text-muted-foreground">
					{t("emptyHistory")}
				</p>
			)}
			<ul className="space-y-3">
				{items.map((state) => (
					<li key={state.jobId}>
						<Link
							className="space-y-2 p-4 focus-visible:outline-violet-500 block rounded-xl border transition-colors hover:bg-secondary focus-visible:outline-2"
							href={`${state.effect ? "/video-effects/hotel-lobby-ai" : "/video"}?job=${encodeURIComponent(state.jobId)}`}
						>
							<p className="font-medium">{t(`stages.${state.stage}`)}</p>
							{state.effect && <p className="text-sm">{state.effect.name}</p>}
							<p className="text-sm text-muted-foreground">
								{t(`credits.${state.creditState}`, { credits: state.credits })}
							</p>
							<p className="text-xs break-all text-muted-foreground">
								{t("jobId", { id: state.jobId })}
							</p>
							<time className="text-xs text-muted-foreground" dateTime={state.updatedAt}>
								{new Date(state.updatedAt).toLocaleString()}
							</time>
						</Link>
					</li>
				))}
			</ul>
			{history.hasNextPage && (
				<Button
					variant="secondary"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					{t("loadMore")}
				</Button>
			)}
		</div>
	);
}
