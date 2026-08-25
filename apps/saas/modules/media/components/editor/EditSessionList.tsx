"use client";

import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { useEditSessions } from "../../hooks/use-edit-sessions";

export function EditSessionList() {
	const t = useTranslations("media.edits");
	const sessions = useEditSessions();
	const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<div>
			<header className="mb-6">
				<h1 className="text-3xl font-medium">{t("title")}</h1>
				<p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
			</header>
			<div className="divide-y rounded-2xl border bg-background">
				{items.map((session) => (
					<Link
						key={session.id}
						href={`/edits/${encodeURIComponent(session.id)}`}
						className="gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-center grid transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
					>
						<div>
							<h2 className="font-medium">{session.title || t("untitled")}</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								{t("versions", { count: session.versionCount })} ·{" "}
								{new Date(session.updatedAt).toLocaleString()}
							</p>
						</div>
						<span aria-hidden>→</span>
					</Link>
				))}
				{!items.length && !sessions.isLoading && (
					<p className="p-8 text-center text-muted-foreground">{t("empty")}</p>
				)}
			</div>
			{sessions.hasNextPage && (
				<Button
					className="mt-5"
					variant="secondary"
					loading={sessions.isFetchingNextPage}
					onClick={() => sessions.fetchNextPage()}
				>
					{t("more")}
				</Button>
			)}
		</div>
	);
}
