"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { useEditSession } from "../../hooks/use-edit-session";
import { getJobPresentation } from "../../lib/job-status";
import { PromptHistory } from "./PromptHistory";

export function EditVersionTimeline({ sessionId }: { sessionId: string }) {
	const t = useTranslations("media.edits");
	const stages = useTranslations("media.status.stages");
	const products = useTranslations("media.create.products");
	const session = useEditSession(sessionId);
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState("");

	if (session.isError && !session.data) {
		return <UnavailableSession />;
	}
	if (!session.data) return <div aria-busy="true">{t("loading")}</div>;

	async function rename() {
		const normalized = title.trim();
		if (!normalized) return;
		setRenaming(true);
		try {
			await orpcClient.media.renameEditSession({ sessionId, title: normalized });
			setTitle("");
			await session.refetch();
		} finally {
			setRenaming(false);
		}
	}

	return (
		<div>
			<Link href="/edits" className="text-sm text-muted-foreground">
				← {t("back")}
			</Link>
			<header className="mt-5 gap-4 sm:flex-row sm:items-end flex flex-col justify-between">
				<div>
					<h1 className="text-3xl font-medium">{session.data.title || t("untitled")}</h1>
					<p className="mt-1 text-muted-foreground">
						{t("versions", { count: session.data.versions.length })}
					</p>
				</div>
				<form
					className="gap-2 flex"
					onSubmit={(event) => {
						event.preventDefault();
						void rename();
					}}
				>
					<label className="sr-only" htmlFor="edit-session-title">
						{t("renameLabel")}
					</label>
					<input
						id="edit-session-title"
						className="h-9 min-w-0 px-3 text-sm rounded-md border bg-background"
						value={title}
						maxLength={120}
						placeholder={t("renamePlaceholder")}
						onChange={(event) => setTitle(event.target.value)}
					/>
					<Button
						type="submit"
						size="sm"
						variant="secondary"
						disabled={!title.trim()}
						loading={renaming}
					>
						{t("rename")}
					</Button>
				</form>
			</header>
			<ol className="mt-7 space-y-5">
				{session.data.versions.map((version, index) => {
					const stage = getJobPresentation({ status: version.status }).stage;
					const outputAssetId = version.output.assetId;
					return (
						<li
							key={version.id}
							className="p-5 md:grid-cols-[12rem_1fr] md:p-6 gap-6 grid rounded-2xl border bg-background"
						>
							<VersionThumbnail version={version} />
							<div>
								<div className="gap-3 flex flex-wrap items-center">
									<h2 className="font-medium">{t("version", { number: index + 1 })}</h2>
									<Badge status="info">{stages(stage)}</Badge>
								</div>
								<p className="mt-2 text-sm text-muted-foreground">
									{products(`${version.productKey}.label`)} ·{" "}
									{t("credits", { credits: version.credits })} ·{" "}
									{new Date(version.createdAt).toLocaleString()}
								</p>
								<PromptHistory label={t("prompt")} prompt={version.prompt} />
								{version.canEditAgain && outputAssetId && (
									<Button
										className="mt-5"
										variant="secondary"
										render={(props) => (
											<Link
												{...props}
												href={`/create?asset=${encodeURIComponent(outputAssetId)}&parentJob=${encodeURIComponent(version.id)}`}
											/>
										)}
									>
										{t("editAgain")}
									</Button>
								)}
							</div>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

function VersionThumbnail({
	version,
}: {
	version: {
		output: { state: string; assetId: string | null };
	};
}) {
	const t = useTranslations("media.edits");
	if (version.output.state === "DELETED") {
		return (
			<div className="p-4 text-sm flex aspect-square items-center justify-center rounded-xl bg-muted text-center text-muted-foreground">
				{t("assetDeleted")}
			</div>
		);
	}
	if (version.output.state !== "READY" || !version.output.assetId) {
		return (
			<div className="p-4 text-sm flex aspect-square items-center justify-center rounded-xl bg-muted text-center text-muted-foreground">
				{t("outputUnavailable")}
			</div>
		);
	}
	return <PrivateThumbnail assetId={version.output.assetId} />;
}

function PrivateThumbnail({ assetId }: { assetId: string }) {
	const t = useTranslations("media.edits");
	const access = useQuery({
		queryKey: ["media-asset-preview", assetId],
		queryFn: () => orpcClient.media.getAssetAccessUrl({ assetId, disposition: "inline" }),
		staleTime: 4 * 60_000,
	});
	if (!access.data || access.isError) {
		return (
			<div className="p-4 text-sm flex aspect-square items-center justify-center rounded-xl bg-muted text-center text-muted-foreground">
				{t("outputUnavailable")}
			</div>
		);
	}
	return (
		<img
			src={access.data.url}
			alt={t("thumbnailAlt")}
			className="aspect-square size-full rounded-xl object-cover"
		/>
	);
}

function UnavailableSession() {
	const t = useTranslations("media.edits");
	return (
		<div>
			<Link href="/edits" className="text-sm text-muted-foreground">
				← {t("back")}
			</Link>
			<div className="mt-5 p-8 rounded-2xl border">
				<h1 className="text-2xl font-medium">{t("unavailableTitle")}</h1>
				<p className="mt-2 text-muted-foreground">{t("unavailableDescription")}</p>
			</div>
		</div>
	);
}
