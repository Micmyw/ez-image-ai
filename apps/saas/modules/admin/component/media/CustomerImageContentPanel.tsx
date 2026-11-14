"use client";

import type {
	AdminImageContent,
	AdminImageContentDetail,
	AdminImageStatus,
} from "@repo/api/modules/media/admin-content-types";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { AdminDiagnosticCode } from "../../components/AdminDiagnosticCode";
import { AdminContentCleanupPanel } from "./AdminContentCleanupPanel";
import { ModerationPromptRecords } from "./ModerationPromptRecords";

export function CustomerImageContentPanel() {
	const t = useTranslations("admin.media.content");
	const locale = useLocale();
	const [status, setStatus] = useState<AdminImageStatus | "">("QUARANTINED");
	const [kind, setKind] = useState<"INPUT" | "OUTPUT" | "">("");
	const [audience, setAudience] = useState<"GUEST" | "ACCOUNT" | "">("");
	const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
	const [searchDraft, setSearchDraft] = useState("");
	const [search, setSearch] = useState("");
	const [before, setBefore] = useState<{ createdAt: Date; id: string }>();
	const [assetId, setAssetId] = useState<string | null>(null);
	const list = useQuery({
		...orpc.media.adminImageContentList.queryOptions({
			input: {
				limit: 25,
				before,
				...(status ? { status } : {}),
				...(kind ? { kind } : {}),
				...(audience ? { audience } : {}),
				...(search ? { search } : {}),
			},
		}),
		staleTime: 30_000,
		retry: false,
		refetchOnWindowFocus: false,
	});
	return (
		<Card className="space-y-4 p-5" id="customer-content">
			<h2 className="text-xl font-semibold">{t("title")}</h2>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			<form
				className="gap-3 flex flex-wrap items-end"
				onSubmit={(event) => {
					event.preventDefault();
					setSearch(searchDraft.trim());
					setBefore(undefined);
				}}
			>
				<label className="space-y-1 text-sm">
					<span className="block">{t("audienceLabel")}</span>
					<select
						className="p-2 rounded-md border bg-background"
						value={audience}
						onChange={(event) => {
							setAudience(event.target.value as typeof audience);
							setBefore(undefined);
						}}
					>
						<option value="">{t("all")}</option>
						<option value="GUEST">{t("audiences.GUEST")}</option>
						<option value="ACCOUNT">{t("audiences.ACCOUNT")}</option>
					</select>
				</label>
				<label className="space-y-1 text-sm">
					<span className="block">{t("statusLabel")}</span>
					<select
						className="p-2 rounded-md border bg-background"
						value={status}
						onChange={(e) => {
							setStatus(e.target.value as AdminImageStatus | "");
							setBefore(undefined);
						}}
					>
						<option value="">{t("all")}</option>
						{(
							[
								"QUARANTINED",
								"VERIFICATION_FAILED",
								"VERIFYING",
								"READY",
								"DELETED",
								"UPLOADING",
							] as const
						).map((value) => (
							<option key={value} value={value}>
								{t(`statuses.${value}`)}
							</option>
						))}
					</select>
				</label>
				<label className="space-y-1 text-sm">
					<span className="block">{t("kindLabel")}</span>
					<select
						className="p-2 rounded-md border bg-background"
						value={kind}
						onChange={(e) => {
							setKind(e.target.value as typeof kind);
							setBefore(undefined);
						}}
					>
						<option value="">{t("all")}</option>
						<option value="INPUT">{t("kinds.INPUT")}</option>
						<option value="OUTPUT">{t("kinds.OUTPUT")}</option>
					</select>
				</label>
				<label className="min-w-48 space-y-1 text-sm flex-1">
					<span className="block">{t("searchLabel")}</span>
					<Input
						value={searchDraft}
						maxLength={160}
						onChange={(e) => setSearchDraft(e.target.value)}
						placeholder={t("searchPlaceholder")}
					/>
				</label>
				<Button type="submit" size="sm">
					{t("search")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={list.isFetching}
					onClick={() => void list.refetch()}
				>
					{t("refresh")}
				</Button>
			</form>
			{list.isPending && <p aria-busy="true">{t("loading")}</p>}
			{list.isError && <p role="alert">{t("loadError")}</p>}
			{list.data && (
				<div className="overflow-x-auto">
					<table className="text-sm w-full text-left">
						<caption className="sr-only">{t("title")}</caption>
						<thead>
							<tr>
								<th className="p-2">{t("cleanup.select")}</th>
								{(
									[
										"time",
										"owner",
										"kindLabel",
										"statusLabel",
										"provider",
										"reason",
										"inspect",
									] as const
								).map((key) => (
									<th className="p-2" key={key}>
										{t(key)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{list.data.items.map((image) => (
								<tr className="border-t align-top" key={image.id}>
									<td className="p-2">
										<input
											type="checkbox"
											aria-label={`${t("cleanup.select")} ${image.id}`}
											checked={selectedAssets.includes(image.id)}
											disabled={!selectedAssets.includes(image.id) && selectedAssets.length >= 20}
											onChange={(event) =>
												setSelectedAssets((current) =>
													event.target.checked
														? [...current, image.id]
														: current.filter((id) => id !== image.id),
												)
											}
										/>
									</td>
									<td className="p-2 whitespace-nowrap">
										{new Intl.DateTimeFormat(locale, {
											dateStyle: "short",
											timeStyle: "short",
										}).format(new Date(image.createdAt))}
									</td>
									<td className="max-w-44 p-2 text-xs break-all">
										{image.ownerType} · {image.ownerId}
										{image.audience && (
											<span className="block">{t(`audiences.${image.audience}`)}</span>
										)}
									</td>
									<td className="p-2">{t(`kinds.${image.kind}`)}</td>
									<td className="p-2">{t(`statuses.${image.status}`)}</td>
									<td className="p-2">{image.provider ?? "—"}</td>
									<td className="max-w-64 p-2 break-words">
										<ContentReason reason={image.reasonCode} />
									</td>
									<td className="p-2">
										<Button size="sm" variant="outline" onClick={() => setAssetId(image.id)}>
											{t("inspect")}
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{!list.data.items.length && <p className="p-3">{t("empty")}</p>}
				</div>
			)}
			<div className="gap-2 flex">
				{before && (
					<Button size="sm" variant="outline" onClick={() => setBefore(undefined)}>
						{t("newest")}
					</Button>
				)}
				{list.data?.nextCursor && (
					<Button size="sm" variant="outline" onClick={() => setBefore(list.data!.nextCursor!)}>
						{t("older")}
					</Button>
				)}
			</div>
			{assetId && (
				<CustomerImageDialog key={assetId} assetId={assetId} onClose={() => setAssetId(null)} />
			)}
			<AdminContentCleanupPanel
				key={selectedAssets.join(",")}
				assetIds={selectedAssets}
				onQueued={() => {
					void list.refetch();
				}}
			/>
		</Card>
	);
}

function CustomerImageDialog({ assetId, onClose }: { assetId: string; onClose: () => void }) {
	const t = useTranslations("admin.media.content");
	const [jobId, setJobId] = useState<string>();
	const detail = useQuery({
		...orpc.media.adminImageContentDetail.queryOptions({ input: { assetId, jobId } }),
		gcTime: 0,
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-6xl max-h-[90svh] w-[calc(100%-2rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("detailTitle")}</DialogTitle>
				</DialogHeader>
				{detail.isPending && <p aria-busy="true">{t("loading")}</p>}
				{detail.isError && <p role="alert">{t("loadError")}</p>}
				<Button
					size="sm"
					variant="outline"
					disabled={detail.isFetching}
					onClick={() => void detail.refetch()}
				>
					{t("refreshPreview")}
				</Button>
				{detail.data && (
					<>
						{detail.data.jobs.length > 0 && (
							<label className="space-y-1 text-sm block">
								<span className="block">{t("job")}</span>
								<select
									className="p-2 max-w-full rounded-md border bg-background"
									value={detail.data.selectedJobId ?? ""}
									onChange={(e) => setJobId(e.target.value)}
								>
									{detail.data.jobs.map((job) => (
										<option key={job.id} value={job.id}>
											{job.id} · {job.productKey}
										</option>
									))}
								</select>
							</label>
						)}
						<AdminImageContentView
							key={`${detail.data.selectedJobId}:${detail.data.image.previewUrl}`}
							detail={detail.data}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function AdminImageContentView({ detail }: { detail: AdminImageContentDetail }) {
	const t = useTranslations("admin.media.content");
	const selectedJob = detail.jobs.find((job) => job.id === detail.selectedJobId);
	const otherPromptRecords = detail.promptRecords.filter(
		(record) => !detail.prompt || record.jobId !== detail.selectedJobId,
	);
	const images = [detail.image, ...detail.relatedImages].sort((a, b) =>
		a.role.localeCompare(b.role),
	);
	return (
		<div className="space-y-5">
			<p className="text-sm break-all">
				{detail.ownerType} · {detail.ownerId}
				{detail.audience && <> · {t(`audiences.${detail.audience}`)}</>}
			</p>
			{selectedJob?.failureCode && (
				<p className="text-sm">
					<AdminDiagnosticCode code={selectedJob.failureCode} />
				</p>
			)}
			{!detail.jobs.length && <p className="text-sm text-muted-foreground">{t("noJob")}</p>}
			{detail.failureMessage && <p className="text-sm break-words">{detail.failureMessage}</p>}
			{detail.cleanup && (
				<output className="text-sm block">
					{t(`cleanup.states.${detail.cleanup.state}`)} ·{" "}
					{t("cleanup.attempts", { count: detail.cleanup.attempts })}
				</output>
			)}
			<div className="gap-4 lg:grid-cols-2 grid">
				{images.map((image) => (
					<ImageInspection key={`${image.id}:${image.previewUrl}`} image={image} />
				))}
			</div>
			{detail.prompt && (
				<section className="space-y-2">
					<h3 className="font-semibold">{t("prompt")}</h3>
					<pre className="p-4 text-sm rounded-lg bg-muted break-words whitespace-pre-wrap">
						{detail.prompt}
					</pre>
				</section>
			)}
			{(otherPromptRecords.length > 0 || !detail.prompt) && (
				<ModerationPromptRecords records={otherPromptRecords} />
			)}
			{Boolean(detail.promptReviews?.length) && (
				<section className="space-y-2">
					<h3 className="font-semibold">{t("promptReview")}</h3>
					{detail.promptReviews!.map((review) => (
						<div key={review.id} className="space-y-1 p-3 text-sm rounded-lg border">
							<p>
								{review.provider} · {review.decision} · {review.action} · {review.semanticStatus}
							</p>
							<p>
								<ContentReason reason={review.reasonCode} />
							</p>
							<p>{review.categories.join(", ") || t("noLabels")}</p>
						</div>
					))}
				</section>
			)}
			{Boolean(detail.attempts?.length) && (
				<section className="space-y-2">
					<h3 className="font-semibold">{t("modelDiagnostics")}</h3>
					{detail.attempts!.map((attempt) => (
						<div key={attempt.id} className="space-y-1 p-3 text-sm rounded-lg border">
							<p>
								{attempt.provider} · {attempt.status}
							</p>
							<p className="font-mono text-xs break-all">{attempt.providerTaskId}</p>
							<p>
								{t(`evidenceSources.${attempt.evidenceSource}`)}
								{attempt.terminalStatus && ` · ${attempt.terminalStatus} · ${attempt.verifiedAt}`}
							</p>
							{attempt.uncertainSubmission && (
								<p className="text-amber-700">{t("uncertainSubmission")}</p>
							)}
							<p>
								<ContentReason reason={attempt.errorCode} />
							</p>
							{attempt.errorMessage && (
								<>
									<p className="break-words">{attempt.errorMessage}</p>
									{attempt.messageSource && (
										<p className="text-xs text-muted-foreground">
											{t(`messageSources.${attempt.messageSource}`)} · {attempt.messageObservedAt}
										</p>
									)}
								</>
							)}
						</div>
					))}
				</section>
			)}
		</div>
	);
}

function ContentReason({ reason }: { reason: string | null }) {
	const t = useTranslations("admin.media.moderation.errors");
	if (!reason) return <>—</>;
	return (
		<>
			{t.has(reason as "SEEAPI_CONTENT_NOT_ALLOWED") && (
				<span className="block">{t(reason as "SEEAPI_CONTENT_NOT_ALLOWED")}</span>
			)}
			<code className="text-xs">{reason}</code>
		</>
	);
}

function ImageInspection({ image }: { image: AdminImageContent }) {
	const t = useTranslations("admin.media.content");
	const [failed, setFailed] = useState(false);
	const review = image.review;
	return (
		<section className="min-w-0 space-y-3 p-3 rounded-lg border">
			<h3 className="font-semibold">{t(`kinds.${image.role}`)}</h3>
			<p className="font-mono text-xs break-all text-muted-foreground">{image.id}</p>
			{image.previewUrl && !failed && (
				<a
					href={image.previewUrl}
					target="_blank"
					rel="noopener noreferrer"
					referrerPolicy="no-referrer"
				>
					<img
						src={image.previewUrl}
						alt={t(`kinds.${image.role}`)}
						className="max-h-[32rem] w-full rounded-lg object-contain"
						referrerPolicy="no-referrer"
						onError={() => setFailed(true)}
					/>
					<span className="mt-2 text-sm block underline">{t("openImage")}</span>
				</a>
			)}
			{(failed || image.previewError) && <p role="alert">{t("previewError")}</p>}
			{image.availability !== "AVAILABLE" && <p>{t(`availability.${image.availability}`)}</p>}
			{review && !review.current && <p className="text-amber-700">{t("historical")}</p>}
			{review ? (
				<dl className="space-y-2 text-sm">
					<div>
						<dt className="text-muted-foreground">{t("provider")}</dt>
						<dd>
							{review.provider} · {review.status}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">{t("reason")}</dt>
						<dd>
							<ContentReason reason={review.reasonCode} />
							{review.failureCode && (
								<span className="block">
									{review.failureStatus} · {review.failureCode}
								</span>
							)}
						</dd>
					</div>
					{review.providerTaskId && (
						<div>
							<dt className="text-muted-foreground">{t("providerTask")}</dt>
							<dd className="font-mono text-xs break-all">{review.providerTaskId}</dd>
						</div>
					)}
					<div>
						<dt className="text-muted-foreground">{t("labels")}</dt>
						<dd>{review.nsfw.length ? review.nsfw.join(", ") : t("noLabels")}</dd>
					</div>
					{review.specialCare.length > 0 && (
						<div>
							<dt className="text-muted-foreground">{t("specialCare")}</dt>
							<dd>{review.specialCare.join(", ")}</dd>
						</div>
					)}
				</dl>
			) : (
				<p className="text-sm text-muted-foreground">{t("noReview")}</p>
			)}
		</section>
	);
}
