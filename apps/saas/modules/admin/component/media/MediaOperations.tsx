"use client";

import { EZPIC_PRODUCT_KEYS } from "@repo/config/client";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { toastPromise } from "@repo/ui/components/toast";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { GrowthOperationsPanel } from "./GrowthOperationsPanel";

const AUDIT_PAGE_SIZE = 20;

function operationKey(): string {
	return crypto.randomUUID();
}

export function MediaOperations() {
	const t = useTranslations("admin.media");
	const queryClient = useQueryClient();
	const [eventId, setEventId] = useState("");
	const [eventKind, setEventKind] = useState<"PAYMENT" | "PROVIDER">("PAYMENT");
	const [jobId, setJobId] = useState("");
	const [stage, setStage] = useState<"DISPATCH" | "FINALIZE" | "SETTLE">("FINALIZE");
	const [productKey, setProductKey] = useState<(typeof EZPIC_PRODUCT_KEYS)[number]>("image-fast");
	const [reason, setReason] = useState("");
	const diagnostics = useQuery(
		orpc.media.adminMediaDiagnostics.queryOptions({ refetchInterval: 15_000 }),
	);
	const audit = useQuery(
		orpc.media.listMediaAuditLog.queryOptions({ input: { limit: AUDIT_PAGE_SIZE } }),
	);
	const replayEvent = useMutation(orpc.media.replayMediaEvent.mutationOptions());
	const retryStage = useMutation(orpc.media.retryMediaJobStage.mutationOptions());
	const setOverride = useMutation(orpc.media.setMediaRuntimeOverride.mutationOptions());
	const rollback = useMutation(orpc.media.rollbackMediaRuntimeOverride.mutationOptions());

	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.media.adminGrowthOperations.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.media.adminMediaDiagnostics.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.media.listMediaAuditLog.key() }),
		]);
	};
	const run = (work: Promise<unknown>) =>
		toastPromise(
			async () => {
				await work;
				await refresh();
			},
			{
				loading: t("operations.running"),
				success: t("operations.success"),
				error: t("operations.error"),
			},
		);
	const data = diagnostics.data;
	const paymentEventFailureCount =
		(data?.events.payment.failed.count ?? 0) + (data?.events.payment.deadLetter.count ?? 0);

	return (
		<div className="space-y-6">
			<GrowthOperationsPanel />
			<div className="gap-4 md:grid-cols-2 xl:grid-cols-4 grid">
				<Metric
					title={t("metrics.queue")}
					value={data?.queue.depth ?? 0}
					detail={t("metrics.oldest", { seconds: data?.queue.oldestAgeSeconds ?? 0 })}
					alert={(data?.queue.oldestAgeSeconds ?? 0) > 5}
				/>
				<Metric
					title={t("metrics.stalled")}
					value={(data?.queue.stalledJobs ?? 0) + (data?.queue.needsReconciliation ?? 0)}
					alert={(data?.queue.stalledJobs ?? 0) > 0 || (data?.queue.needsReconciliation ?? 0) > 0}
				/>
				<Metric
					title={t("metrics.outbox")}
					value={data?.outbox.pending ?? 0}
					detail={t("metrics.deadLetter", { count: data?.outbox.deadLetter ?? 0 })}
					alert={(data?.outbox.deadLetter ?? 0) > 0}
				/>
				<Metric
					title={t("metrics.margin")}
					value={data?.finance.marginMicros ?? "0"}
					detail={t("metrics.micros")}
					alert={BigInt(data?.finance.marginMicros ?? "0") < 0n}
				/>
				<Metric
					title={t("metrics.storage")}
					value={data?.storage.readyBytes ?? "0"}
					detail={t("metrics.bytes")}
				/>
				<Metric
					title={t("metrics.credits")}
					value={data?.credits.spendable ?? "0"}
					detail={t("metrics.debt", { amount: data?.credits.debt ?? "0" })}
					alert={BigInt(data?.credits.debt ?? "0") > 0n}
				/>
				<Metric
					title={t("metrics.providerFailures")}
					value={data?.providers.reduce((total, item) => total + item.failed, 0) ?? 0}
					alert={(data?.providers.reduce((total, item) => total + item.failed, 0) ?? 0) > 0}
				/>
				<Metric
					title={t("metrics.eventFailures")}
					value={(data?.events.providerFailed ?? 0) + paymentEventFailureCount}
					alert={(data?.events.providerFailed ?? 0) + paymentEventFailureCount > 0}
				/>
			</div>

			<Card className="p-6">
				<h2 className="font-semibold text-xl">{t("paymentEvents.title")}</h2>
				<div className="mt-4 gap-3 lg:grid-cols-3 grid">
					{data &&
						(
							[
								["FAILED", data.events.payment.failed],
								["DEAD_LETTER", data.events.payment.deadLetter],
								["IGNORED", data.events.payment.ignored],
							] as const
						).map(([status, bucket]) => (
							<div key={status} className="space-y-2 p-3 rounded-md border">
								<div className="flex items-center justify-between">
									<code className="text-sm">{status}</code>
									<span className="font-medium text-sm">{bucket.count}</span>
								</div>
								{bucket.items.length === 0 ? (
									<p className="text-sm text-muted-foreground">{t("paymentEvents.empty")}</p>
								) : (
									bucket.items.map((item) => (
										<div key={item.id} className="pt-2 text-xs border-t">
											<code className="break-all">{item.id}</code>
											<p className="mt-1 break-all text-muted-foreground">
												{item.providerEventId} · {item.attemptCount}/
												{item.lastTriggerAttempt ?? "-"} · {item.lastErrorClass ?? "-"}
											</p>
										</div>
									))
								)}
							</div>
						))}
				</div>
			</Card>

			<Card className="p-6">
				<h2 className="font-semibold text-xl">{t("operations.title")}</h2>
				<p className="mt-1 text-sm text-muted-foreground">{t("operations.description")}</p>
				<div className="mt-4 gap-4 lg:grid-cols-3 grid">
					<Operation title={t("operations.replay.title")}>
						<Select
							value={eventKind}
							onValueChange={(value) => setEventKind(value as typeof eventKind)}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="PAYMENT">Payment</SelectItem>
								<SelectItem value="PROVIDER">Provider</SelectItem>
							</SelectContent>
						</Select>
						<Input
							value={eventId}
							onChange={(event) => setEventId(event.target.value)}
							placeholder={t("operations.eventId")}
						/>
						<Button
							disabled={!eventId || reason.length < 10 || replayEvent.isPending}
							onClick={() =>
								run(
									replayEvent.mutateAsync({
										eventId,
										eventKind,
										reason,
										idempotencyKey: operationKey(),
									}),
								)
							}
						>
							{t("operations.replay.action")}
						</Button>
					</Operation>
					<Operation title={t("operations.retry.title")}>
						<Select value={stage} onValueChange={(value) => setStage(value as typeof stage)}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="DISPATCH">Dispatch</SelectItem>
								<SelectItem value="FINALIZE">Finalize</SelectItem>
								<SelectItem value="SETTLE">Settle</SelectItem>
							</SelectContent>
						</Select>
						<Input
							value={jobId}
							onChange={(event) => setJobId(event.target.value)}
							placeholder={t("operations.jobId")}
						/>
						<Button
							disabled={!jobId || reason.length < 10 || retryStage.isPending}
							onClick={() =>
								run(
									retryStage.mutateAsync({ jobId, stage, reason, idempotencyKey: operationKey() }),
								)
							}
						>
							{t("operations.retry.action")}
						</Button>
					</Operation>
					<Operation title={t("operations.override.title")}>
						<Select
							value={productKey}
							onValueChange={(value) => setProductKey(value as typeof productKey)}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{EZPIC_PRODUCT_KEYS.map((key) => (
									<SelectItem key={key} value={key}>
										{key === "image-fast" ? "Standard Edit" : "Quality Edit"}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="gap-2 flex">
							<Button
								variant="destructive"
								disabled={reason.length < 10 || setOverride.isPending}
								onClick={() =>
									run(
										setOverride.mutateAsync({
											scope: "MODEL",
											productKey,
											enabled: false,
											reason,
											idempotencyKey: operationKey(),
										}),
									)
								}
							>
								{t("operations.override.disable")}
							</Button>
							<Button
								variant="outline"
								disabled={reason.length < 10 || setOverride.isPending}
								onClick={() =>
									run(
										setOverride.mutateAsync({
											scope: "MODEL",
											productKey,
											enabled: true,
											reason,
											idempotencyKey: operationKey(),
										}),
									)
								}
							>
								{t("operations.override.enable")}
							</Button>
						</div>
					</Operation>
				</div>
				<Input
					className="mt-4"
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					placeholder={t("operations.reason")}
				/>
			</Card>

			<Card className="p-6">
				<h2 className="font-semibold text-xl">{t("overrides.title")}</h2>
				<div className="mt-4 space-y-2">
					{data?.overrides.map((item) => (
						<div
							key={item.id}
							className="gap-3 p-3 flex flex-wrap items-center justify-between rounded-md border"
						>
							<div>
								<code className="text-sm">{item.configKey}</code>
								<p className="text-xs text-muted-foreground">
									v{item.version} · {item.reason}
								</p>
							</div>
							<Button
								size="sm"
								variant="outline"
								disabled={reason.length < 10 || rollback.isPending}
								onClick={() =>
									run(
										rollback.mutateAsync({
											overrideId: item.id,
											reason,
											idempotencyKey: operationKey(),
										}),
									)
								}
							>
								{t("overrides.rollback")}
							</Button>
						</div>
					))}
				</div>
			</Card>

			<Card className="p-6">
				<h2 className="font-semibold text-xl">{t("audit.title")}</h2>
				<div className="mt-4 divide-y rounded-md border">
					{audit.data?.items.map((item) => (
						<div key={item.id} className="gap-1 p-3 text-sm md:grid-cols-[1fr_1fr_auto] grid">
							<span>{item.action}</span>
							<span className="text-muted-foreground">
								{item.targetType}: {item.targetId}
							</span>
							<time className="text-muted-foreground">
								{new Date(item.createdAt).toLocaleString()}
							</time>
						</div>
					))}
				</div>
			</Card>
		</div>
	);
}

function Metric({
	title,
	value,
	detail,
	alert = false,
}: {
	title: string;
	value: string | number;
	detail?: string;
	alert?: boolean;
}) {
	return (
		<Card className="p-5">
			<div className="gap-2 flex items-center justify-between">
				<p className="text-sm text-muted-foreground">{title}</p>
				{alert && <Badge status="error">Alert</Badge>}
			</div>
			<p className="mt-2 font-semibold text-2xl">{value}</p>
			{detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
		</Card>
	);
}

function Operation({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="space-y-3 p-4 rounded-md border">
			<h3 className="font-medium">{title}</h3>
			{children}
		</div>
	);
}
