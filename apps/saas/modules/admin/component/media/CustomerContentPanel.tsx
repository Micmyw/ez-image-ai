"use client";

import { adminImageStatusSchema } from "@repo/api/modules/media/admin-content-types";
import type {
	AdminContentCustomer,
	AdminContentCustomersInput,
	AdminCustomerContent,
	AdminCustomerContentInput,
} from "@repo/api/modules/media/admin-customer-content-types";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { AdminDiagnosticCode } from "../../components/AdminDiagnosticCode";
import { AdminContentCleanupPanel } from "./AdminContentCleanupPanel";
import { PromptDetailDialog } from "./AdminPromptContentPanel";
import { CustomerImageDialog } from "./CustomerImageContentPanel";

const queryPolicy = { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } as const;
const selectClass = "w-full rounded-md border bg-background p-2 text-sm";

export function CustomerContentPanel() {
	const t = useTranslations("admin.media.customers");
	const locale = useLocale();
	const [draft, setDraft] = useState("");
	const [input, setInput] = useState<AdminContentCustomersInput>({ limit: 25 });
	const [selected, setSelected] = useState<AdminContentCustomer | null>(null);
	const list = useQuery({
		...orpc.media.adminContentCustomers.queryOptions({ input }),
		...queryPolicy,
		enabled: !selected,
	});
	return (
		<Card className="space-y-5 p-5" id="customer-content" data-clarity-mask="true">
			{selected ? (
				<CustomerContentDetail
					key={`${selected.ownerType}:${selected.ownerId}`}
					customer={selected}
					onBack={() => {
						setSelected(null);
						void list.refetch();
					}}
				/>
			) : (
				<>
					<div>
						<h2 className="text-xl font-semibold">{t("title")}</h2>
						<p className="mt-2 text-sm text-muted-foreground">{t("description")}</p>
					</div>
					<form
						className="gap-3 flex flex-wrap items-end"
						onSubmit={(event) => {
							event.preventDefault();
							setInput((current) => ({
								...current,
								search: draft.trim() || undefined,
								before: undefined,
							}));
						}}
					>
						<label className="min-w-48 space-y-1 text-sm flex-1">
							<span className="block">{t("searchLabel")}</span>
							<Input
								value={draft}
								maxLength={254}
								placeholder={t("searchPlaceholder")}
								onChange={(event) => setDraft(event.target.value)}
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className="block">{t("audience")}</span>
							<select
								className={selectClass}
								value={input.audience ?? ""}
								onChange={(event) =>
									setInput((current) => ({
										...current,
										audience: (event.target.value ||
											undefined) as AdminContentCustomersInput["audience"],
										before: undefined,
									}))
								}
							>
								<option value="">{t("all")}</option>
								{(["ACCOUNT", "GUEST", "UNKNOWN"] as const).map((value) => (
									<option key={value} value={value}>
										{t(`audiences.${value}`)}
									</option>
								))}
							</select>
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
					{list.isError && <p role="alert">{t(list.data ? "staleError" : "loadError")}</p>}
					{list.data && (
						<>
							<div className="overflow-x-auto">
								<table className="text-sm w-full min-w-[52rem] text-left">
									<caption className="sr-only">{t("title")}</caption>
									<thead>
										<tr>
											{(
												[
													"customer",
													"uploads",
													"outputs",
													"jobs",
													"blocked",
													"issues",
													"lastActivity",
													"open",
												] as const
											).map((key) => (
												<th key={key} className="p-2 whitespace-nowrap">
													{t(key)}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{list.data.items.map((customer) => (
											<tr
												key={`${customer.ownerType}:${customer.ownerId}`}
												className="border-t align-top"
											>
												<td className="max-w-64 p-2">
													<button
														type="button"
														className="font-medium text-left break-all text-primary hover:underline"
														onClick={() => setSelected(customer)}
													>
														<CustomerName customer={customer} />
													</button>
													<p className="mt-1 text-xs text-muted-foreground">
														{t(`audiences.${customer.audience}`)} ·{" "}
														{t(`identityTypes.${customer.ownerType}`)}
													</p>
													{customer.email && customer.name && (
														<p className="text-xs text-muted-foreground">{customer.name}</p>
													)}
												</td>
												{[
													customer.inputCount,
													customer.outputCount,
													customer.jobCount,
													customer.blockedCount,
													customer.issueCount,
												].map((count, index) => (
													<td key={index} className="p-2 tabular-nums">
														{count}
													</td>
												))}
												<td className="p-2 whitespace-nowrap">
													{formatTime(customer.lastActivityAt, locale)}
												</td>
												<td className="p-2">
													<Button size="sm" variant="outline" onClick={() => setSelected(customer)}>
														{t("open")}
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{!list.data.items.length && (
								<p className="py-5 text-center text-muted-foreground">{t("empty")}</p>
							)}
							<div className="gap-2 flex">
								<Button
									size="sm"
									variant="outline"
									disabled={!input.before || list.isFetching}
									onClick={() => setInput((current) => ({ ...current, before: undefined }))}
								>
									{t("newest")}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={!list.data.nextCursor || list.isFetching}
									onClick={() =>
										setInput((current) => ({
											...current,
											before: list.data?.nextCursor ?? undefined,
										}))
									}
								>
									{t("older")}
								</Button>
							</div>
						</>
					)}
				</>
			)}
		</Card>
	);
}

export function CustomerContentDetail({
	customer,
	onBack,
}: {
	customer: AdminContentCustomer;
	onBack: () => void;
}) {
	const t = useTranslations("admin.media.customers");
	const content = useTranslations("admin.media.content");
	const locale = useLocale();
	const [filters, setFilters] = useState<Omit<AdminCustomerContentInput, "owner">>({ limit: 25 });
	const [selected, setSelected] = useState<AdminCustomerContent["items"][number] | null>(null);
	const [assetIds, setAssetIds] = useState<string[]>([]);
	const list = useQuery({
		...orpc.media.adminCustomerContent.queryOptions({
			input: { ...filters, owner: { ownerType: customer.ownerType, ownerId: customer.ownerId } },
		}),
		...queryPolicy,
	});
	return (
		<div className="space-y-5">
			<Button size="sm" variant="outline" onClick={onBack}>
				{t("back")}
			</Button>
			<div className="space-y-2">
				<h2 className="text-xl font-semibold break-all">
					<CustomerName customer={customer} />
				</h2>
				<p className="text-sm break-all text-muted-foreground">
					{t(`audiences.${customer.audience}`)} · {t(`identityTypes.${customer.ownerType}`)} ·{" "}
					{customer.ownerId}
				</p>
				{customer.audience === "GUEST" && (
					<p className="text-sm text-muted-foreground">
						{t(
							customer.ownerType === "GUEST_BROWSER"
								? "browserIdentityNote"
								: "missingBrowserIdentityNote",
						)}
					</p>
				)}
				<p className="text-sm text-muted-foreground">{t("history")}</p>
			</div>
			<div className="gap-3 text-sm flex flex-wrap">
				{(
					[
						["uploads", customer.inputCount],
						["outputs", customer.outputCount],
						["jobs", customer.jobCount],
						["blocked", customer.blockedCount],
					] as const
				).map(([label, count]) => (
					<span key={label} className="px-3 py-2 rounded-md bg-muted">
						{t(label)} <strong className="ml-2 tabular-nums">{count}</strong>
					</span>
				))}
			</div>
			<div className="gap-3 flex flex-wrap items-end">
				<label className="space-y-1 text-sm">
					<span className="block">{t("kind")}</span>
					<select
						className={selectClass}
						value={filters.kind ?? ""}
						onChange={(event) =>
							setFilters((current) => ({
								...current,
								kind: (event.target.value || undefined) as AdminCustomerContentInput["kind"],
								before: undefined,
							}))
						}
					>
						<option value="">{t("all")}</option>
						{(["INPUT", "OUTPUT", "JOB", "BLOCKED_REQUEST"] as const).map((kind) => (
							<option key={kind} value={kind}>
								{t(`kinds.${kind}`)}
							</option>
						))}
					</select>
				</label>
				<label className="gap-2 py-2 text-sm flex items-center">
					<input
						type="checkbox"
						checked={filters.issuesOnly ?? false}
						onChange={(event) =>
							setFilters((current) => ({
								...current,
								issuesOnly: event.target.checked,
								before: undefined,
							}))
						}
					/>
					{t("issuesOnly")}
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={list.isFetching}
					onClick={() => void list.refetch()}
				>
					{t("refresh")}
				</Button>
			</div>
			{list.isPending && <p aria-busy="true">{t("loading")}</p>}
			{list.isError && <p role="alert">{t(list.data ? "staleError" : "loadError")}</p>}
			{list.data && (
				<>
					<div className="overflow-x-auto">
						<table className="text-sm w-full min-w-[52rem] text-left">
							<caption className="sr-only">{t("timeline")}</caption>
							<thead>
								<tr>
									<th className="p-2">{content("cleanup.select")}</th>
									{(["time", "kind", "model", "status", "inspect"] as const).map((key) => (
										<th key={key} className="p-2">
											{t(key)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{list.data.items.map((row) => (
									<tr key={`${row.recordKind}:${row.id}`} className="border-t align-top">
										<td className="p-2">
											{(row.recordKind === "INPUT" || row.recordKind === "OUTPUT") && (
												<input
													type="checkbox"
													aria-label={`${content("cleanup.select")} ${row.id}`}
													checked={assetIds.includes(row.id)}
													disabled={!assetIds.includes(row.id) && assetIds.length >= 20}
													onChange={(event) =>
														setAssetIds((current) =>
															event.target.checked
																? [...current, row.id]
																: current.filter((id) => id !== row.id),
														)
													}
												/>
											)}
										</td>
										<td className="p-2 whitespace-nowrap">{formatTime(row.createdAt, locale)}</td>
										<td className="max-w-56 p-2">
											<p>{t(`kinds.${row.recordKind}`)}</p>
											<code className="text-xs break-all text-muted-foreground">{row.id}</code>
										</td>
										<td className="max-w-48 p-2 break-words">{row.productKey ?? "—"}</td>
										<td className="max-w-72 p-2">
											{(row.recordKind === "INPUT" || row.recordKind === "OUTPUT") &&
											adminImageStatusSchema.safeParse(row.status).success ? (
												content(`statuses.${adminImageStatusSchema.parse(row.status)}`)
											) : (
												<AdminDiagnosticCode code={row.status} />
											)}
											{row.reasonCode && (
												<p className="mt-1">
													<AdminDiagnosticCode code={row.reasonCode} />
												</p>
											)}
										</td>
										<td className="p-2">
											<Button size="sm" variant="outline" onClick={() => setSelected(row)}>
												{t(
													row.recordKind === "INPUT" || row.recordKind === "OUTPUT"
														? "inspectImage"
														: "inspectPrompt",
												)}
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{!list.data.items.length && (
						<p className="py-5 text-center text-muted-foreground">{t("noContent")}</p>
					)}
					<div className="gap-2 flex">
						<Button
							size="sm"
							variant="outline"
							disabled={!filters.before || list.isFetching}
							onClick={() => setFilters((current) => ({ ...current, before: undefined }))}
						>
							{t("newest")}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!list.data.nextCursor || list.isFetching}
							onClick={() =>
								setFilters((current) => ({
									...current,
									before: list.data?.nextCursor ?? undefined,
								}))
							}
						>
							{t("older")}
						</Button>
					</div>
				</>
			)}
			{selected &&
				(selected.recordKind === "INPUT" || selected.recordKind === "OUTPUT" ? (
					<CustomerImageDialog
						key={selected.id}
						assetId={selected.id}
						onClose={() => setSelected(null)}
					/>
				) : (
					<PromptDetailDialog
						key={`${selected.recordKind}:${selected.id}`}
						selected={{ id: selected.id, recordKind: selected.recordKind }}
						close={() => setSelected(null)}
					/>
				))}
			<details>
				<summary className="text-sm font-medium cursor-pointer">
					{content("cleanup.title")} {assetIds.length > 0 && `(${assetIds.length})`}
				</summary>
				<div className="mt-3">
					<AdminContentCleanupPanel
						key={assetIds.join(",")}
						assetIds={assetIds}
						onQueued={() => void list.refetch()}
					/>
				</div>
			</details>
		</div>
	);
}

function formatTime(value: Date, locale: string) {
	return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
		new Date(value),
	);
}

function CustomerName({ customer }: { customer: AdminContentCustomer }) {
	const t = useTranslations("admin.media.customers");
	if (customer.ownerType === "GUEST_BROWSER")
		return t("guestBrowser", { id: customer.ownerId.slice(-8) });
	if (customer.audience === "GUEST")
		return t(customer.ownerId.startsWith("guest_upload_") ? "unlinkedUpload" : "guestSession", {
			id: customer.ownerId.slice(-8),
		});
	return customer.email ?? customer.name ?? customer.ownerId;
}
