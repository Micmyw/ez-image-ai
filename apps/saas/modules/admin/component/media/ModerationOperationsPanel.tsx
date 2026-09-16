"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { Textarea } from "@repo/ui/components/textarea";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";

type ReviewFilter = "PENDING_REVIEW" | "RECHECKING" | "BLOCKED" | "APPROVED" | "REJECTED";
type ReviewAction = "APPROVE" | "REJECT" | "RECHECK";

export function ModerationOperationsPanel() {
	const t = useTranslations("admin.media.moderation");
	const locale = useLocale();
	const queryClient = useQueryClient();
	const [status, setStatus] = useState<ReviewFilter | undefined>();
	const [cursor, setCursor] = useState<{ before: string; beforeId: string } | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	const [resultMessage, setResultMessage] = useState<string | null>(null);
	const operationKeys = useRef(new Map<string, string>());
	const operations = useQuery({
		...orpc.media.adminModerationOperations.queryOptions({
			input: { limit: 25, ...cursor, ...(status ? { status } : {}) },
		}),
		refetchInterval: 15_000,
	});
	const details = useQuery({
		...orpc.media.adminModerationDetail.queryOptions({ input: { reviewId: selectedId ?? "" } }),
		enabled: Boolean(selectedId),
		staleTime: 0,
		gcTime: 0,
	});
	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: orpc.media.adminModerationOperations.key() });
		await queryClient.invalidateQueries({ queryKey: orpc.media.adminModerationDetail.key() });
		await queryClient.invalidateQueries({ queryKey: orpc.media.listMediaAuditLog.key() });
	};
	const action = useMutation(
		orpc.media.adminModerationReviewAction.mutationOptions({
			onSuccess: async () => {
				setResultMessage(t("saved"));
				setReason("");
				await refresh();
			},
		}),
	);
	const acknowledge = useMutation(
		orpc.media.adminModerationAcknowledge.mutationOptions({ onSuccess: refresh }),
	);
	const time = (date: Date | null) =>
		date
			? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
					new Date(date),
				)
			: "—";
	const statusLabel = (value: string) =>
		t.has(`statuses.${value}`) ? t(`statuses.${value}` as never) : value;
	const errorLabel = (value: string) =>
		t.has(`errors.${value}`) ? t(`errors.${value}` as never) : t("errors.MODERATION_UNAVAILABLE");
	const runAction = (selectedAction: ReviewAction) => {
		if (!details.data) return;
		const review = details.data.review;
		const signature = `${review.id}:${review.version}:${selectedAction}:${reason.trim()}`;
		const idempotencyKey = operationKeys.current.get(signature) ?? crypto.randomUUID();
		operationKeys.current.set(signature, idempotencyKey);
		setResultMessage(null);
		action.mutate({
			reviewId: review.id,
			version: review.version,
			action: selectedAction,
			reason: reason.trim(),
			idempotencyKey,
		});
	};
	const review = details.data?.review;
	const canAct =
		review &&
		["PENDING_REVIEW", "BLOCKED", "RECHECKING"].includes(review.status) &&
		reason.trim().length >= 10 &&
		!action.isPending;

	return (
		<section id="moderation" className="space-y-5" aria-labelledby="moderation-heading">
			<div>
				<h2 id="moderation-heading" className="text-xl font-semibold">
					{t("title")}
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
			</div>
			{operations.isError && (
				<p role="alert" className="text-destructive">
					{t("loadError")}
				</p>
			)}
			{operations.isPending && <output>{t("loading")}</output>}
			{operations.data && (
				<>
					<div className="gap-3 sm:grid-cols-2 grid">
						<Card className="p-4">
							<p className="text-sm text-muted-foreground">{t("openIncidents")}</p>
							<p className="mt-2 text-3xl font-semibold">{operations.data.openCount}</p>
						</Card>
						<Card className="p-4">
							<p className="text-sm text-muted-foreground">{t("pendingReviews")}</p>
							<p className="mt-2 text-3xl font-semibold">{operations.data.pendingCount}</p>
						</Card>
					</div>
					{operations.data.openCount > 0 && (
						<div
							role="alert"
							className="border-amber-500/40 bg-amber-500/10 p-4 text-sm rounded-lg border"
						>
							{t("outageWarning")}
						</div>
					)}
					<Card className="space-y-4 p-5">
						<details className="space-y-4">
							<summary className="font-semibold cursor-pointer">{t("incidents")}</summary>
							{!operations.data.incidents.length && (
								<p className="text-sm text-muted-foreground">{t("noIncidents")}</p>
							)}
							{operations.data.incidents.map((incident) => (
								<article key={incident.id} className="space-y-2 p-4 rounded-lg border">
									<div className="gap-2 flex flex-wrap items-center justify-between">
										<p className="font-medium">
											{incident.provider} ·{" "}
											{t(incident.stage === "TEXT" ? "textStage" : "imageStage")}
										</p>
										<Badge>{statusLabel(incident.status)}</Badge>
									</div>
									<p className="text-sm">{errorLabel(incident.lastErrorCode)}</p>
									<dl className="gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3 grid">
										<div>
											<dt className="text-muted-foreground">{t("failureCount")}</dt>
											<dd>{incident.failureCount}</dd>
										</div>
										<div>
											<dt className="text-muted-foreground">{t("affectedTargets")}</dt>
											<dd>{incident.affectedTargets}</dd>
										</div>
										<div>
											<dt className="text-muted-foreground">{t("firstFailure")}</dt>
											<dd>{time(incident.firstFailureAt)}</dd>
										</div>
										<div>
											<dt className="text-muted-foreground">{t("lastFailure")}</dt>
											<dd>{time(incident.lastFailureAt)}</dd>
										</div>
										<div>
											<dt className="text-muted-foreground">{t("recoveredAt")}</dt>
											<dd>{time(incident.recoveredAt)}</dd>
										</div>
									</dl>
									<details>
										<summary className="text-sm cursor-pointer">{t("references")}</summary>
										<ul className="mt-2 space-y-1 font-mono text-xs break-all">
											{incident.targets.map((target) => (
												<li key={`${target.targetType}:${target.targetId}`}>
													{target.targetType}: {target.targetId}
												</li>
											))}
										</ul>
									</details>
									{incident.status === "OPEN" && (
										<Button
											size="sm"
											variant="outline"
											disabled={Boolean(incident.acknowledgedAt) || acknowledge.isPending}
											onClick={() =>
												acknowledge.mutate({
													incidentId: incident.id,
													reason: "Acknowledged via moderation operations dashboard.",
												})
											}
										>
											{incident.acknowledgedAt ? t("acknowledged") : t("acknowledge")}
										</Button>
									)}
								</article>
							))}
						</details>
					</Card>
					<Card className="space-y-4 p-5">
						<div className="gap-3 flex flex-wrap items-center justify-between">
							<h3 className="font-semibold">{t("reviewQueue")}</h3>
							<label className="gap-2 text-sm flex items-center">
								{t("filter")}
								<select
									className="p-2 rounded-md border bg-background"
									value={status ?? ""}
									onChange={(event) => {
										setStatus((event.target.value || undefined) as ReviewFilter | undefined);
										setCursor(null);
									}}
								>
									<option value="">{t("needsAttention")}</option>
									{(
										["PENDING_REVIEW", "RECHECKING", "BLOCKED", "APPROVED", "REJECTED"] as const
									).map((value) => (
										<option key={value} value={value}>
											{statusLabel(value)}
										</option>
									))}
								</select>
							</label>
						</div>
						<p className="text-sm text-muted-foreground">{t("billingNote")}</p>
						{!operations.data.reviews.length && (
							<p className="text-sm text-muted-foreground">{t("noReviews")}</p>
						)}
						<div className="space-y-3">
							{operations.data.reviews.map((item) => (
								<article
									key={item.id}
									className="gap-3 p-4 flex flex-wrap items-start justify-between rounded-lg border"
								>
									<div className="min-w-0 space-y-1">
										<div className="gap-2 flex flex-wrap items-center">
											<Badge>{statusLabel(item.status)}</Badge>
											{item.bypassed && (
												<span className="text-sm">{t("allowedPendingReview")}</span>
											)}
										</div>
										<p className="font-mono text-xs break-all">{item.targetId}</p>
										<p className="text-sm text-muted-foreground">
											{item.provider} · {t(item.stage === "TEXT" ? "textStage" : "imageStage")} ·{" "}
											{t("failures", { count: item.failureCount })} · {time(item.lastFailureAt)}
										</p>
										{item.jobIds.length > 0 && (
											<p className="text-xs break-all">
												{t("jobs")}: {item.jobIds.join(", ")}
											</p>
										)}
									</div>
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setSelectedId(item.id);
											setReason("");
											setResultMessage(null);
											action.reset();
										}}
									>
										{t("inspect")}
									</Button>
								</article>
							))}
						</div>
						<div className="gap-2 flex">
							{cursor && (
								<Button size="sm" variant="outline" onClick={() => setCursor(null)}>
									{t("newest")}
								</Button>
							)}
							{operations.data.nextCursor && (
								<Button
									size="sm"
									variant="outline"
									onClick={() => setCursor(operations.data!.nextCursor)}
								>
									{t("older")}
								</Button>
							)}
						</div>
					</Card>
				</>
			)}
			<Dialog
				open={Boolean(selectedId)}
				onOpenChange={(open) => {
					if (!open) setSelectedId(null);
				}}
			>
				<DialogContent className="max-w-2xl max-h-[85svh] w-[calc(100%-2rem)] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{t("reviewDetails")}</DialogTitle>
					</DialogHeader>
					{details.isPending && <p>{t("loading")}</p>}
					{details.isError && <p role="alert">{t("loadError")}</p>}
					{details.data && (
						<>
							<p className="text-sm break-all">
								{details.data.review.targetId} · {statusLabel(details.data.review.status)}
							</p>
							{details.data.prompt && (
								<pre className="p-4 text-sm rounded-lg bg-muted break-words whitespace-pre-wrap">
									{details.data.prompt}
								</pre>
							)}
							{details.data.imageUrl && (
								<img
									src={details.data.imageUrl}
									alt={t("imageAlt")}
									className="max-h-96 max-w-full rounded-lg object-contain"
									referrerPolicy="no-referrer"
								/>
							)}
							<Button size="sm" variant="outline" onClick={() => void details.refetch()}>
								{t("refreshPreview")}
							</Button>
							{details.data.uncertainSubmission && (
								<p className="text-sm text-amber-700 dark:text-amber-300">{t("uncertainNote")}</p>
							)}
							{review?.resolutionReason && (
								<p className="text-sm">
									{t("lastDecision")}: {review.resolutionReason}
								</p>
							)}
							<label className="space-y-2 text-sm block">
								<span>{t("reason")}</span>
								<Textarea
									value={reason}
									maxLength={500}
									onChange={(event) => setReason(event.target.value)}
									placeholder={t("reasonPlaceholder")}
								/>
							</label>
							<div className="gap-2 flex flex-wrap">
								<Button
									variant="outline"
									disabled={!canAct || details.data.uncertainSubmission}
									onClick={() => runAction("RECHECK")}
								>
									{t("recheck")}
								</Button>
								<Button disabled={!canAct} onClick={() => runAction("APPROVE")}>
									{t("approve")}
								</Button>
								<Button
									variant="destructive"
									disabled={!canAct}
									onClick={() => runAction("REJECT")}
								>
									{t("reject")}
								</Button>
							</div>
						</>
					)}
					{action.isError && (
						<p role="alert" className="text-sm text-destructive">
							{t("actionError")}
						</p>
					)}
					{resultMessage && <output className="text-sm">{resultMessage}</output>}
				</DialogContent>
			</Dialog>
			{acknowledge.isError && (
				<p role="alert" className="text-sm text-destructive">
					{t("actionError")}
				</p>
			)}
		</section>
	);
}
