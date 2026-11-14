"use client";

import type { AdminContentCleanupPlan } from "@repo/api/modules/media/admin-content-cleanup-types";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function AdminContentCleanupPanel({
	assetIds,
	onQueued,
}: {
	assetIds: string[];
	onQueued: () => void;
}) {
	const t = useTranslations("admin.media.content.cleanup");
	const [reason, setReason] = useState("");
	const [includeLogs, setIncludeLogs] = useState(false);
	const [plan, setPlan] = useState<AdminContentCleanupPlan | null>(null);
	const [confirmation, setConfirmation] = useState("");
	const [restoredConfirmedPlan, setRestoredConfirmedPlan] = useState(false);
	const recent = useQuery({
		...orpc.media.adminContentCleanupRecent.queryOptions({ input: {} }),
		staleTime: 30_000,
		refetchOnWindowFocus: false,
		retry: false,
	});
	const preview = useMutation(orpc.media.adminContentCleanupPreview.mutationOptions());
	const execute = useMutation(orpc.media.adminContentCleanupExecute.mutationOptions());
	const busy = preview.isPending || execute.isPending;
	return (
		<section className="space-y-3 p-4 rounded-lg border">
			<h3 className="font-semibold">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			<p className="text-sm">{t("selected", { count: assetIds.length })}</p>
			{Boolean(recent.data?.length) && (
				<label className="space-y-1 text-sm block">
					<span>{t("recentPlans")}</span>
					<select
						className="p-2 max-w-full rounded-md border bg-background"
						value={restoredConfirmedPlan ? (plan?.planId ?? "") : ""}
						disabled={busy}
						onChange={(event) => {
							const previous = recent.data?.find((entry) => entry.planId === event.target.value);
							setPlan(previous ?? null);
							setRestoredConfirmedPlan(Boolean(previous));
							setConfirmation("");
							execute.reset();
							preview.reset();
						}}
					>
						<option value="">{t("chooseRecent")}</option>
						{recent.data!.map((entry) => (
							<option key={entry.planId} value={entry.planId}>
								{entry.planId} · {entry.assetCount} / {entry.logCount}
							</option>
						))}
					</select>
				</label>
			)}
			{recent.isError && <p role="alert">{t("recentError")}</p>}
			<label className="space-y-1 text-sm block">
				<span>{t("reason")}</span>
				<Input
					value={reason}
					maxLength={500}
					disabled={busy}
					onChange={(event) => {
						setReason(event.target.value);
						setPlan(null);
						setRestoredConfirmedPlan(false);
						execute.reset();
					}}
				/>
			</label>
			<label className="gap-2 text-sm flex items-center">
				<input
					type="checkbox"
					checked={includeLogs}
					disabled={busy}
					onChange={(event) => {
						setIncludeLogs(event.target.checked);
						setPlan(null);
						execute.reset();
					}}
				/>
				{t("includeLogs")}
			</label>
			<Button
				size="sm"
				variant="outline"
				disabled={busy || reason.trim().length < 5 || (!assetIds.length && !includeLogs)}
				onClick={async () => {
					setPlan(null);
					setRestoredConfirmedPlan(false);
					setConfirmation("");
					execute.reset();
					try {
						setPlan(
							await preview.mutateAsync({
								assetIds,
								reason,
								includeExpiredInternalDiagnostics: includeLogs,
							}),
						);
					} catch {
						/* Mutation state supplies the bounded error. */
					}
				}}
			>
				{t("preview")}
			</Button>
			{preview.isError && <p role="alert">{t("previewError")}</p>}
			{plan && (
				<div className="space-y-3">
					<AdminCleanupPlanSummary plan={plan} />
					{!execute.isSuccess && (
						<>
							<label className="space-y-1 text-sm block">
								<span>{t("confirmLabel")}</span>
								<code className="block break-all">{plan.confirmation}</code>
								<Input
									aria-label={t("confirmLabel")}
									value={confirmation}
									onChange={(event) => setConfirmation(event.target.value)}
									disabled={busy}
									autoComplete="off"
								/>
							</label>
							<Button
								variant="destructive"
								size="sm"
								disabled={
									busy ||
									confirmation !== plan.confirmation ||
									(!plan.assetCount && !plan.logCount) ||
									(!restoredConfirmedPlan && Date.now() >= new Date(plan.expiresAt).getTime())
								}
								onClick={async () => {
									try {
										await execute.mutateAsync({
											planId: plan.planId,
											planHash: plan.planHash,
											confirmation,
										});
										onQueued();
										void recent.refetch();
									} catch {
										/* Keep the same plan for safe idempotent retry. */
									}
								}}
							>
								{restoredConfirmedPlan
									? t("retryPhysical")
									: execute.isError
										? t("retry")
										: t("execute")}
							</Button>
						</>
					)}
				</div>
			)}
			{execute.isError && <p role="alert">{t("executeError")}</p>}
			{execute.isSuccess && (
				<output className="block">
					{t("queued", { assets: execute.data.queuedAssets, logs: execute.data.deletedLogs })}
				</output>
			)}
			{execute.isSuccess && plan && plan.assetCount > 0 && (
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={async () => {
						try {
							await execute.mutateAsync({
								planId: plan.planId,
								planHash: plan.planHash,
								confirmation: plan.confirmation,
							});
							onQueued();
						} catch {
							/* Same identity is retained for another safe retry. */
						}
					}}
				>
					{t("retryPhysical")}
				</Button>
			)}
		</section>
	);
}

export function AdminCleanupPlanSummary({ plan }: { plan: AdminContentCleanupPlan }) {
	const t = useTranslations("admin.media.content.cleanup");
	return (
		<div className="space-y-2 text-sm">
			<p>
				{t("summary", {
					assets: plan.assetCount,
					bytes: plan.assetBytes,
					logs: plan.logCount,
					logBytes: plan.logBytes,
				})}
			</p>
			<p>{t("expiry", { time: new Date(plan.expiresAt).toISOString() })}</p>
			<ul className="space-y-1">
				{plan.assets.map((asset) => (
					<li key={asset.id} className="break-all">
						<code>{asset.id}</code> · {asset.bytes} B ·{" "}
						{asset.blocked.length
							? asset.blocked.map((code) => t(`blocked.${code}` as "blocked.NOT_FOUND")).join("; ")
							: t("eligible")}
					</li>
				))}
			</ul>
		</div>
	);
}
