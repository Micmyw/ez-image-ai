"use client";

import { Button } from "@repo/ui/components/button";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { CapabilityError, CapabilityLoading } from "./CapabilityUi";

export function CheckoutDiagnosticsPanel({ range }: { range: "24h" | "7d" | "30d" }) {
	const t = useTranslations("admin.conversion.checkoutDiagnostics");
	const product = useTranslations("admin.conversion");
	const [draft, setDraft] = useState("");
	const [reference, setReference] = useState("");
	const query = useQuery(
		orpc.payments.getAdminCheckoutDiagnostics.queryOptions({
			input: { range, limit: 20, ...(reference ? { reference } : {}) },
		}),
	);
	return (
		<section className="space-y-3 p-4 rounded-lg border" aria-label={t("title")}>
			<h3 className="font-medium">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t("basis")}</p>
			<p className="text-sm">{t("coverageHint")}</p>
			<form
				className="gap-2 flex flex-wrap items-center"
				onSubmit={(event) => {
					event.preventDefault();
					setReference(draft.trim());
				}}
			>
				<label className="text-sm gap-2 flex items-center">
					{t("reference")}
					<input
						value={draft}
						maxLength={128}
						onChange={(event) => setDraft(event.target.value)}
						className="rounded p-2 border bg-background"
					/>
				</label>
				<Button type="submit" variant="outline">
					{t("search")}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					{t("refresh")}
				</Button>
			</form>
			<CapabilityError error={query.error} />
			<CapabilityLoading loading={query.isPending} />
			{query.data?.truncated && <output className="text-sm">{t("truncated")}</output>}
			{query.data?.rows.length === 0 && <p>{t("empty")}</p>}
			{query.data?.rows.map((row) => (
				<details key={row.id} className="rounded p-3 border">
					<summary className="text-sm font-medium cursor-pointer">
						{product(row.productKind as "IMAGE_PASS")} · {row.provider} · {row.planKey} ·{" "}
						{t(`outcomes.${row.outcome}`)}
						<span className="ml-2 font-mono text-xs">{row.id}</span>
					</summary>
					<div className="my-3 space-y-1 text-xs break-all">
						<p>
							{t("purchaseEvidence")} · {row.createdAt} (UTC)
						</p>
						<p>
							{t("owner")}: {row.ownerType} / {row.ownerId} · {t("localStatus")}: {row.status}
						</p>
						{row.expired && <p>{t("expired")}</p>}
						{!row.events.some(({ diagnostic }) => diagnostic.source === "browser") && (
							<p>{t("noBrowser")}</p>
						)}
						{row.events.length === 0 && <p>{t("noEvents")}</p>}
						{row.eventsTruncated && <p>{t("timelineTruncated")}</p>}
						{row.unreadableEvents > 0 && (
							<p>{t("invalidEvents", { count: row.unreadableEvents })}</p>
						)}
					</div>
					<ol className="space-y-2 text-sm">
						{row.events.map(({ id, receivedAt, diagnostic: event }) => (
							<li key={id} className="pl-3 border-l-2">
								<p className="text-xs text-muted-foreground">
									{t("receivedAt")}: {receivedAt} (UTC) · {t(`sources.${event.source}`)}
								</p>
								{event.source === "browser" ? (
									<p>{t(`browser.${event.event}`)}</p>
								) : (
									<>
										<p>
											{t(`operations.${event.operation}`)} · {t(`phases.${event.phase}`)}
											{event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ""}
										</p>
										<p className="text-xs text-muted-foreground">
											{t("attempt")}: {event.attemptId}
										</p>
										{event.error && (
											<p className="font-mono text-xs break-all">
												{[
													event.error.kind,
													event.error.code,
													event.error.httpStatus && `HTTP ${event.error.httpStatus}`,
													event.error.providerIssue,
													event.error.debugId && `PayPal debug ID: ${event.error.debugId}`,
												]
													.filter(Boolean)
													.join(" · ")}
											</p>
										)}
									</>
								)}
							</li>
						))}
					</ol>
				</details>
			))}
		</section>
	);
}
