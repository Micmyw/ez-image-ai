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

interface GuestDiagnostics {
	admission: { accepted: number; deniedByReason: Array<{ reason: string; count: number }> };
	queue: {
		depth: number;
		oldestAgeSeconds: number;
		waitMs: { p50: number | null; p95: number | null };
		expiredBeforeDispatch: number;
	};
	risk: {
		budgetMicros: string;
		heldMicros: string;
		committedMicros: string;
		releasedMicros: string;
		utilizationPercent: number;
		state: "OK" | "WARN" | "SLOW" | "CLOSED" | "EXHAUSTED";
	};
	sponsorCredits: { granted: string; reserved: string; settled: string; released: string };
	attempts: {
		accepted: number;
		rejected: number;
		uncertain: number;
		uncertainOlderThanTenMinutes: number;
		reportedCostCovered: number;
		reportedCostMissing: number;
		billedSpendMismatch: number;
	};
	moderation: { approved: number; rejected: number; errors: number; errorRate: number | null };
	watermark: { succeeded: number; failed: number };
	resultAccess: { ready: number; grantsCompleted: number; expiredGrants: number };
	cleanup: {
		expiredAssets: number;
		overdueAssets: number;
		deadLetterEvents: number;
		oldestOverdueSeconds: number;
	};
	controls: {
		environmentEnabled: boolean;
		runtimeEnabled: boolean;
		admissionOpen: boolean;
		automaticClosureReasons: string[];
	};
}

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
			<GuestOperationsPanel data={data?.guest} />
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

function GuestOperationsPanel({ data }: { data?: GuestDiagnostics }) {
	const t = useTranslations("admin.media.guest");
	const diagnosticLabel = (kind: GuestDiagnosticKind, value: string) =>
		formatGuestDiagnosticLabel(kind, value, (key) => t(key as never));
	const unsafe = Boolean(
		data &&
		(!data.controls.admissionOpen ||
			data.watermark.failed > 0 ||
			data.cleanup.overdueAssets > 0 ||
			data.attempts.billedSpendMismatch > 0),
	);
	return (
		<Card className="p-6">
			<div className="gap-3 flex flex-wrap items-start justify-between">
				<div>
					<h2 className="font-semibold text-xl">{t("title")}</h2>
					<p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
				</div>
				{data && (
					<Badge status={unsafe ? "error" : "success"}>{t(unsafe ? "attention" : "healthy")}</Badge>
				)}
			</div>

			{data ? (
				<>
					<div className="mt-4 gap-2 flex flex-wrap">
						<GuestControlBadge
							label={t("controls.environment")}
							enabled={data.controls.environmentEnabled}
						/>
						<GuestControlBadge
							label={t("controls.runtime")}
							enabled={data.controls.runtimeEnabled}
						/>
						<GuestControlBadge
							label={t("controls.admission")}
							enabled={data.controls.admissionOpen}
						/>
					</div>
					<div className="mt-5 gap-3 sm:grid-cols-2 xl:grid-cols-4 grid">
						<SummaryCard
							title={t("metrics.risk")}
							value={`${formatPercent(data.risk.utilizationPercent)} · ${diagnosticLabel("state", data.risk.state)}`}
							detail={t("details.risk", {
								held: data.risk.heldMicros,
								committed: data.risk.committedMicros,
								budget: data.risk.budgetMicros,
							})}
							alert={data.risk.state !== "OK"}
						/>
						<SummaryCard
							title={t("metrics.queue")}
							value={data.queue.depth}
							detail={t("details.queue", {
								age: data.queue.oldestAgeSeconds,
								p50: data.queue.waitMs.p50 ?? "-",
								p95: data.queue.waitMs.p95 ?? "-",
							})}
							alert={data.queue.depth > 20 || data.queue.oldestAgeSeconds > 300}
						/>
						<SummaryCard
							title={t("metrics.attempts")}
							value={`${data.attempts.accepted} / ${data.attempts.rejected} / ${data.attempts.uncertain}`}
							detail={t("details.attempts", {
								covered: data.attempts.reportedCostCovered,
								missing: data.attempts.reportedCostMissing,
							})}
							alert={
								data.attempts.uncertainOlderThanTenMinutes > 0 ||
								data.attempts.billedSpendMismatch > 0
							}
						/>
						<SummaryCard
							title={t("metrics.moderation")}
							value={`${data.moderation.approved} / ${data.moderation.rejected} / ${data.moderation.errors}`}
							detail={t("details.errorRate", {
								rate:
									data.moderation.errorRate === null
										? "-"
										: formatPercent(data.moderation.errorRate * 100),
							})}
							alert={(data.moderation.errorRate ?? 0) > 0.01}
						/>
						<SummaryCard
							title={t("metrics.watermark")}
							value={`${data.watermark.succeeded} / ${data.watermark.failed}`}
							alert={data.watermark.failed > 0}
						/>
						<SummaryCard
							title={t("metrics.results")}
							value={`${data.resultAccess.ready} / ${data.resultAccess.grantsCompleted}`}
							detail={t("details.expiredGrants", { count: data.resultAccess.expiredGrants })}
						/>
						<SummaryCard
							title={t("metrics.sponsorCredits")}
							value={`${data.sponsorCredits.granted} / ${data.sponsorCredits.settled}`}
							detail={t("details.credits", {
								reserved: data.sponsorCredits.reserved,
								released: data.sponsorCredits.released,
							})}
						/>
						<SummaryCard
							title={t("metrics.cleanup")}
							value={`${data.cleanup.expiredAssets} / ${data.cleanup.overdueAssets}`}
							detail={t("details.cleanup", {
								deadLetters: data.cleanup.deadLetterEvents,
								seconds: data.cleanup.oldestOverdueSeconds,
							})}
							alert={data.cleanup.overdueAssets > 0 || data.cleanup.deadLetterEvents > 0}
						/>
					</div>

					<div className="mt-5 gap-4 lg:grid-cols-2 grid">
						<AggregateList
							title={t("denials")}
							empty={t("empty")}
							items={data.admission.deniedByReason.map((item) => ({
								label: diagnosticLabel("reason", item.reason),
								value: item.count,
							}))}
						/>
						<AggregateList
							title={t("automaticClosures")}
							empty={t("empty")}
							items={data.controls.automaticClosureReasons.map((reason) => ({
								label: diagnosticLabel("reason", reason),
								value: "—",
							}))}
						/>
					</div>
				</>
			) : (
				<p className="mt-5 text-sm text-muted-foreground">{t("loading")}</p>
			)}
		</Card>
	);
}

function GuestControlBadge({ label, enabled }: { label: string; enabled: boolean }) {
	const t = useTranslations("admin.media.guest");
	return (
		<Badge status={enabled ? "success" : "error"}>
			{label}:{" "}
			{formatGuestDiagnosticLabel("control", enabled ? "ON" : "OFF", (key) => t(key as never))}
		</Badge>
	);
}

type GuestDiagnosticKind = "control" | "state" | "reason";

export function formatGuestDiagnosticLabel(
	kind: GuestDiagnosticKind,
	value: string,
	t: (key: string) => string,
): string {
	const key = value
		.toLowerCase()
		.replace(/_+([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
	const namespace = kind === "control" ? "values" : kind === "state" ? "states" : "reasons";
	return t(`${namespace}.${key}`);
}

function SummaryCard({
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
		<div className="p-4 rounded-md border">
			<div className="gap-2 flex items-center justify-between">
				<p className="text-xs text-muted-foreground">{title}</p>
				{alert && <Badge status="error">!</Badge>}
			</div>
			<p className="mt-2 font-semibold text-xl">{value}</p>
			{detail && <p className="mt-1 text-xs break-words text-muted-foreground">{detail}</p>}
		</div>
	);
}

function AggregateList({
	title,
	empty,
	items,
}: {
	title: string;
	empty: string;
	items: Array<{ label: string; value: string | number }>;
}) {
	return (
		<div>
			<h3 className="font-medium">{title}</h3>
			<div className="mt-2 divide-y rounded-md border">
				{items.length ? (
					items.map((item) => (
						<div key={item.label} className="gap-3 p-3 text-sm flex justify-between">
							<code>{item.label}</code>
							<span>{item.value}</span>
						</div>
					))
				) : (
					<p className="p-3 text-sm text-muted-foreground">{empty}</p>
				)}
			</div>
		</div>
	);
}

function formatPercent(value: number): string {
	return `${Math.round(value * 10) / 10}%`;
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
