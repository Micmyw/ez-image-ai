"use client";

import type {
	AdminPromptContentDetail,
	AdminPromptContentInput,
	AdminPromptContentList,
} from "@repo/api/modules/media/admin-prompt-content-types";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { AdminDiagnosticCode } from "../../components/AdminDiagnosticCode";

type Selected = { recordKind: "JOB" | "BLOCKED_REQUEST"; id: string };
const emptyFilters = { ownerId: "", email: "", jobId: "", text: "", from: "", to: "" };

export function AdminPromptContentPanel() {
	const t = useTranslations("admin.media.prompts");
	const locale = useLocale();
	const [draft, setDraft] = useState(emptyFilters);
	const [audience, setAudience] = useState<"" | "GUEST" | "ACCOUNT" | "UNKNOWN">("");
	const [outcome, setOutcome] = useState<"ALL" | "FAILURES">("FAILURES");
	const [input, setInput] = useState<AdminPromptContentInput>({ outcome: "FAILURES", limit: 25 });
	const [before, setBefore] = useState<AdminPromptContentList["nextCursor"]>(null);
	const [selected, setSelected] = useState<Selected | null>(null);
	const [formError, setFormError] = useState(false);
	const list = useQuery({
		...orpc.media.adminPromptContentList.queryOptions({
			input: { ...input, ...(before ? { before } : {}) },
		}),
		staleTime: 30_000,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const time = (value: Date) =>
		new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
			new Date(value),
		);
	return (
		<Card className="space-y-4 p-5" id="customer-prompts" data-clarity-mask="true">
			<h2 className="text-xl font-semibold">{t("title")}</h2>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			<form
				className="gap-3 sm:grid-cols-2 lg:grid-cols-4 grid"
				onSubmit={(event) => {
					event.preventDefault();
					const from = draft.from ? new Date(draft.from) : undefined;
					const to = draft.to ? new Date(draft.to) : undefined;
					const end = to ?? new Date();
					const start = from ?? new Date(end.getTime() - 7 * 24 * 60 * 60_000);
					if (
						!Number.isFinite(start.getTime()) ||
						!Number.isFinite(end.getTime()) ||
						start >= end ||
						end.getTime() - start.getTime() > 90 * 24 * 60 * 60_000
					) {
						setFormError(true);
						return;
					}
					setFormError(false);
					setBefore(null);
					setSelected(null);
					setInput({
						limit: 25,
						outcome,
						...(audience ? { audience } : {}),
						...(from ? { from } : {}),
						...(to ? { to } : {}),
						...Object.fromEntries(
							["ownerId", "email", "jobId", "text"].flatMap((key) => {
								const value = draft[key as keyof typeof draft].trim();
								return value ? [[key, value]] : [];
							}),
						),
					});
				}}
			>
				<label className="space-y-1 text-sm">
					<span className="block">{t("audience")}</span>
					<select
						className="p-2 w-full rounded-md border bg-background"
						value={audience}
						onChange={(event) => setAudience(event.target.value as typeof audience)}
					>
						<option value="">{t("all")}</option>
						{(["GUEST", "ACCOUNT", "UNKNOWN"] as const).map((value) => (
							<option key={value} value={value}>
								{t(`audiences.${value}`)}
							</option>
						))}
					</select>
				</label>
				<label className="space-y-1 text-sm">
					<span className="block">{t("outcome")}</span>
					<select
						className="p-2 w-full rounded-md border bg-background"
						value={outcome}
						onChange={(event) => setOutcome(event.target.value as typeof outcome)}
					>
						<option value="FAILURES">{t("failuresOnly")}</option>
						<option value="ALL">{t("all")}</option>
					</select>
				</label>
				{(["ownerId", "email", "jobId", "text", "from", "to"] as const).map((key) => (
					<label key={key} className="space-y-1 text-sm">
						<span className="block">{t(`filters.${key}`)}</span>
						<Input
							type={
								key === "email"
									? "email"
									: key === "from" || key === "to"
										? "datetime-local"
										: "text"
							}
							value={draft[key]}
							maxLength={key === "email" ? 254 : key === "text" ? 200 : 160}
							onChange={(event) =>
								setDraft((current) => ({ ...current, [key]: event.target.value }))
							}
						/>
					</label>
				))}
				<div className="gap-2 flex">
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
				</div>
			</form>
			{formError && <p role="alert">{t("invalidRange")}</p>}
			{list.isPending && <p aria-busy="true">{t("loading")}</p>}
			{list.isError && <p role="alert">{t(list.data ? "staleError" : "loadError")}</p>}
			{list.data && (
				<>
					<p className="text-sm text-muted-foreground">
						{t("range", { from: time(list.data.from), to: time(list.data.to) })}
					</p>
					<div className="overflow-x-auto">
						<table className="text-sm w-full text-left">
							<caption className="sr-only">{t("title")}</caption>
							<thead>
								<tr>
									{(
										[
											"time",
											"record",
											"owner",
											"model",
											"status",
											"promptSaved",
											"inspect",
										] as const
									).map((key) => (
										<th key={key} className="p-2">
											{t(key)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{list.data.items.map((row) => (
									<tr key={`${row.recordKind}:${row.id}`} className="border-t align-top">
										<td className="p-2 whitespace-nowrap">{time(row.createdAt)}</td>
										<td className="max-w-48 p-2 break-all">
											{t(`kinds.${row.recordKind}`)}
											<code className="text-xs block">{row.id}</code>
										</td>
										<td className="max-w-64 p-2 break-all">
											{row.accountEmail ?? row.ownerId ?? t("unknown")}
											<p>{t(`audiences.${row.audience}`)}</p>
											<p className="text-xs text-muted-foreground">
												{t(`audienceBases.${row.audienceBasis}`)}
											</p>
										</td>
										<td className="p-2">{row.productKey ?? "—"}</td>
										<td className="max-w-64 p-2">
											<AdminDiagnosticCode code={row.status} />
											{row.failureCode && (
												<p>
													<AdminDiagnosticCode code={row.failureCode} />
												</p>
											)}
										</td>
										<td className="p-2">{t(row.hasPrompt ? "yes" : "no")}</td>
										<td className="p-2">
											<Button
												size="sm"
												variant="outline"
												onClick={() => setSelected({ recordKind: row.recordKind, id: row.id })}
											>
												{t("inspect")}
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{!list.data.items.length && <p>{t("empty")}</p>}
					<div className="gap-2 flex">
						<Button
							variant="outline"
							size="sm"
							disabled={!before || list.isFetching}
							onClick={() => setBefore(null)}
						>
							{t("firstPage")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={!list.data.nextCursor || list.isFetching}
							onClick={() => {
								if (list.data) {
									setInput((current) => ({ ...current, from: list.data!.from, to: list.data!.to }));
									setBefore(list.data.nextCursor);
								}
							}}
						>
							{t("nextPage")}
						</Button>
					</div>
				</>
			)}
			{selected && <PromptDetailDialog selected={selected} close={() => setSelected(null)} />}
		</Card>
	);
}

function PromptDetailDialog({ selected, close }: { selected: Selected; close: () => void }) {
	const t = useTranslations("admin.media.prompts");
	const detail = useQuery({
		...orpc.media.adminPromptContentDetail.queryOptions({ input: selected }),
		retry: false,
		refetchOnWindowFocus: false,
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto" closeLabel={t("close")}>
				<DialogHeader>
					<DialogTitle>{t("detailTitle")}</DialogTitle>
				</DialogHeader>
				{detail.isPending && <p aria-busy="true">{t("loading")}</p>}
				{detail.isError && (
					<div role="alert">
						<p>{t("loadError")}</p>
						<Button variant="outline" onClick={() => void detail.refetch()}>
							{t("refresh")}
						</Button>
					</div>
				)}
				{detail.data && <AdminPromptContentDetailBody data={detail.data} />}
			</DialogContent>
		</Dialog>
	);
}

export function AdminPromptContentDetailBody({ data }: { data: AdminPromptContentDetail }) {
	const t = useTranslations("admin.media.prompts");
	return (
		<div className="space-y-5" data-clarity-mask="true">
			<p className="text-sm break-all">
				{t(`kinds.${data.recordKind}`)} · {data.id} · {data.productKey ?? "—"}
			</p>
			<p className="text-sm break-all">
				{t("owner")}: {data.ownerId ?? t("unknown")} · {data.accountEmail ?? "—"} ·{" "}
				{t(`audiences.${data.audience}`)} ({t(`audienceBases.${data.audienceBasis}`)})
			</p>
			<p>
				<AdminDiagnosticCode code={data.status} />
				{data.failureCode && (
					<>
						{" "}
						· <AdminDiagnosticCode code={data.failureCode} />
					</>
				)}
			</p>
			{data.failureMessage && (
				<section>
					<h3 className="font-medium">{t("systemSummary")}</h3>
					<p className="text-sm break-words whitespace-pre-wrap">{data.failureMessage}</p>
				</section>
			)}
			<section className="space-y-2">
				<h3 className="font-medium">{t("promptTitle")}</h3>
				<p className="text-xs text-muted-foreground">
					{t(`promptSources.${data.promptSource}`)} · {t("redaction")}
				</p>
				{data.prompt ? (
					<pre className="p-3 text-sm rounded-md border break-words whitespace-pre-wrap">
						{data.prompt}
					</pre>
				) : (
					<p>{t("missingPrompt")}</p>
				)}
				{data.promptTruncated && <p className="text-sm">{t("truncated")}</p>}
			</section>
			<section className="space-y-3">
				<h3 className="font-medium">{t("reviewTitle")}</h3>
				<p className="text-xs text-muted-foreground">{t("reviewBasis")}</p>
				{!data.promptReviews.length && <p>{t("missingReview")}</p>}
				{data.promptReviews.map((review) => (
					<div key={review.id} className="space-y-1 p-3 text-sm rounded-md border">
						<p>
							{review.provider} · <AdminDiagnosticCode code={review.decision} /> ·{" "}
							{review.createdAt.toISOString()}
						</p>
						<p>
							{t("reviewAction")}: {review.action ?? "—"} · {review.semanticStatus ?? "—"}
						</p>
						{review.reasonCode && (
							<p>
								<AdminDiagnosticCode code={review.reasonCode} />
							</p>
						)}
						<p>
							{t("categories")}: {review.categories.length ? review.categories.join(", ") : "—"}
						</p>
						<p className="text-xs break-all">
							{t("rule")}: {review.ruleVersion ?? "—"} · {t("request")}: {review.requestId ?? "—"}
						</p>
					</div>
				))}
			</section>
			<section className="space-y-3">
				<h3 className="font-medium">{t("messagesTitle")}</h3>
				<p className="text-xs text-muted-foreground">{t("messagesBasis")}</p>
				{!data.attempts.length && <p>{t("missingMessages")}</p>}
				{data.attempts.map((attempt) => (
					<div key={attempt.id} className="space-y-2 p-3 text-sm rounded-md border">
						<p>
							{attempt.provider} · <AdminDiagnosticCode code={attempt.status} /> ·{" "}
							{attempt.createdAt.toISOString()}
						</p>
						{attempt.errorCode && <AdminDiagnosticCode code={attempt.errorCode} />}
						<p className="break-words whitespace-pre-wrap">
							{attempt.errorMessage ?? t("missingMessages")}
						</p>
						<p>
							{t("messageSource")}: {t(`messageSources.${attempt.messageSource}`)}
							{attempt.messageObservedAt ? ` · ${attempt.messageObservedAt}` : ""}
						</p>
						{attempt.uncertainSubmission && <p>{t("uncertain")}</p>}
						<p className="text-xs">
							{t("terminalEvidence")}: {t(`terminalSources.${attempt.evidenceSource}`)} ·{" "}
							{attempt.terminalStatus ?? "—"}
							{attempt.verifiedAt ? ` · ${attempt.verifiedAt}` : ""}
						</p>
					</div>
				))}
			</section>
		</div>
	);
}
