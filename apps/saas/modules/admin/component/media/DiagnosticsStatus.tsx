"use client";

import { Button } from "@repo/ui/components/button";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function DiagnosticsStatus({
	title,
	query,
	intervalMs,
}: {
	title: string;
	query: {
		data: unknown;
		dataUpdatedAt: number;
		isError: boolean;
		isFetching: boolean;
		refetch: () => Promise<unknown>;
	};
	intervalMs: number;
}) {
	const t = useTranslations("admin.media.diagnostics");
	const locale = useLocale();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const update = () => setNow(Date.now());
		const timer = window.setInterval(update, 10_000);
		document.addEventListener("visibilitychange", update);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", update);
		};
	}, []);
	const hasData = query.data !== undefined;
	const stale = hasData && now - query.dataUpdatedAt > intervalMs * 2;
	const warning = query.isError || stale;
	const status = query.isError
		? hasData
			? "refreshFailed"
			: "unavailable"
		: stale
			? "stale"
			: hasData
				? "updated"
				: "loading";
	return (
		<div
			className="gap-3 p-3 text-sm flex flex-wrap items-center justify-between rounded-md border"
			role={warning ? "alert" : "status"}
		>
			<div>
				<p>
					{title} · {t(status)}
				</p>
				{hasData && (
					<p className="text-xs text-muted-foreground">
						{t("lastSuccess", {
							time: new Intl.DateTimeFormat(locale, {
								dateStyle: "short",
								timeStyle: "medium",
							}).format(query.dataUpdatedAt),
						})}
					</p>
				)}
			</div>
			<Button
				size="sm"
				variant="outline"
				disabled={query.isFetching}
				onClick={() => void query.refetch()}
			>
				{t("refresh")}
			</Button>
		</div>
	);
}
