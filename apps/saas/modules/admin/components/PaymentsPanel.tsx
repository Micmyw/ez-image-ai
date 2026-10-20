"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type {
	AdminBillingOrder,
	AdminBillingOrdersResult,
	AdminBillingRefundResult,
} from "@repo/api/modules/admin-billing/schemas";
import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
	moneyMicros,
	useAdminCapabilities,
	useAdminOperation,
	useAdminOperationWrite,
} from "../lib/capabilities-client";
import {
	CapabilityError,
	CapabilityLoading,
	CapabilitySection,
	CapabilitySelect,
} from "./CapabilityUi";

const refundFormSchema = z.object({
	reason: z.string().trim().max(500),
	cancelSubscription: z.boolean(),
	confirmed: z.literal(true),
});
type RefundForm = { reason: string; cancelSubscription: boolean; confirmed: boolean };

export function RefundOutcome({ result }: { result: AdminBillingRefundResult }) {
	const t = useTranslations("admin.capabilities.payments");
	const locale = useLocale();
	return (
		<div aria-live="polite" className="space-y-3 p-4 rounded-lg border">
			<h3 className="font-semibold">
				{t("refundResult")}: {result.status}
			</h3>
			<p className="text-sm">{t("fundsHint")}</p>
			<dl className="gap-2 text-sm sm:grid-cols-2 grid">
				<div>
					<dt>{t("requestId")}</dt>
					<dd className="font-mono break-all">{result.requestId}</dd>
				</div>
				<div>
					<dt>{t("amount")}</dt>
					<dd>{moneyMicros(result.amountMicros, result.currency, locale)}</dd>
				</div>
				<div>
					<dt>{t("creditsRequested")}</dt>
					<dd>{result.credits.requested}</dd>
				</div>
				<div>
					<dt>{t("creditsRevoked")}</dt>
					<dd>{result.credits.revoked}</dd>
				</div>
				<div>
					<dt>{t("debt")}</dt>
					<dd>{result.credits.debtIncurred}</dd>
				</div>
				<div>
					<dt>{t("cancellationResult")}</dt>
					<dd>{result.cancellation.status}</dd>
				</div>
			</dl>
			{result.error && <p className="text-sm text-destructive">{result.error}</p>}
			{result.cancellation.error && (
				<p className="text-sm text-destructive">
					{t("cancellationResult")}: {result.cancellation.error}
				</p>
			)}
			{(["PROCESSING", "UNKNOWN"] as string[]).includes(result.status) && (
				<p className="text-sm">{t("pendingHint")}</p>
			)}
		</div>
	);
}

function RefundDialog({
	order,
	close,
	refresh,
}: {
	order: AdminBillingOrder;
	close: () => void;
	refresh: () => void;
}) {
	const t = useTranslations("admin.capabilities.payments");
	const common = useTranslations("admin.capabilities.common");
	const locale = useLocale();
	const [result, setResult] = useState<AdminBillingRefundResult | null>(null);
	const refund = useAdminOperationWrite<
		{ orderNo: string; reason?: string; cancelSubscription: boolean },
		AdminBillingRefundResult
	>("orders_refund");
	const reconcile = useAdminOperationWrite<{ requestId: string }, AdminBillingRefundResult>(
		"orders_reconcile",
	);
	const form = useForm<RefundForm>({
		defaultValues: { reason: "", cancelSubscription: false, confirmed: false },
	});
	const locked = refund.locked || reconcile.locked || Boolean(result);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !refund.isPending && !reconcile.isPending) close();
			}}
		>
			<DialogContent
				className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto"
				closeDisabled={refund.isPending || reconcile.isPending}
				closeLabel={common("close")}
			>
				<DialogTitle>{t("reviewRefund")}</DialogTitle>
				<DialogDescription>{t("refundPolicy")}</DialogDescription>
				<dl className="gap-3 p-4 text-sm sm:grid-cols-2 grid rounded-lg bg-muted">
					{(
						[
							[t("order"), order.orderNo],
							[t("owner"), `${order.ownerType}: ${order.ownerId}`],
							[t("provider"), order.provider],
							[t("amount"), moneyMicros(order.amountMicros, order.currency, locale)],
							[
								t("alreadyRefunded"),
								moneyMicros(order.refundedAmountMicros, order.currency, locale),
							],
							[t("remaining"), moneyMicros(order.remainingAmountMicros, order.currency, locale)],
						] as const
					).map(([label, value]) => (
						<div key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="break-all">{value}</dd>
						</div>
					))}
				</dl>
				<p className="text-sm font-medium">
					{t(
						order.cancellationPolicyRequired ? "requiredCancellation" : "optionalCancellationHint",
					)}
				</p>
				<CapabilityError error={refund.error} uncertain={refund.uncertain} />
				<CapabilityError error={reconcile.error} uncertain={reconcile.uncertain} />
				{!result && order.canRefund && (
					<form
						className="space-y-4"
						onSubmit={form.handleSubmit(async (values) => {
							const parsed = refundFormSchema.safeParse(values);
							if (!parsed.success) {
								form.setError("confirmed", { message: t("confirmationRequired") });
								return;
							}
							const response = await refund.submit({
								orderNo: order.orderNo,
								...(values.reason.trim() ? { reason: values.reason.trim() } : {}),
								cancelSubscription: order.cancellationPolicyRequired || values.cancelSubscription,
							});
							if (response) {
								setResult(response.result);
								refresh();
							}
						})}
					>
						<fieldset className="space-y-4" disabled={locked}>
							<label className="space-y-1 text-sm block">
								<span>{t("reason")}</span>
								<Textarea maxLength={500} {...form.register("reason")} />
							</label>
							{!order.cancellationPolicyRequired && order.canCancelSubscription && (
								<label className="gap-2 text-sm flex items-start">
									<input
										type="checkbox"
										className="mt-1"
										{...form.register("cancelSubscription")}
									/>
									<span>{t("cancelSubscription")}</span>
								</label>
							)}
							<label className="gap-2 text-sm flex items-start">
								<input type="checkbox" className="mt-1" {...form.register("confirmed")} />
								<span>{t("confirmRefund")}</span>
							</label>
							{form.formState.errors.confirmed && (
								<p role="alert" className="text-sm text-destructive">
									{form.formState.errors.confirmed.message}
								</p>
							)}
							<Button type="submit" variant="destructive" disabled={locked || !order.canRefund}>
								{refund.isPending ? common("saving") : t("refundAction")}
							</Button>
						</fieldset>
					</form>
				)}
				{result && <RefundOutcome result={result} />}
				{(result?.status === "PROCESSING" ||
					result?.status === "UNKNOWN" ||
					order.refundRequestId) && (
					<Button
						variant="outline"
						disabled={reconcile.locked}
						onClick={async () => {
							const requestId = result?.requestId ?? order.refundRequestId;
							if (!requestId) return;
							const response = await reconcile.submit({ requestId });
							if (response) {
								setResult(response.result);
								refresh();
							}
						}}
					>
						{t("reconcile")}
					</Button>
				)}
				<Button
					variant="outline"
					disabled={refund.isPending || reconcile.isPending}
					onClick={close}
				>
					{common("close")}
				</Button>
			</DialogContent>
		</Dialog>
	);
}

export function PaymentsPanel() {
	const t = useTranslations("admin.capabilities.payments");
	const common = useTranslations("admin.capabilities.common");
	const locale = useLocale();
	const capabilities = useAdminCapabilities();
	const searchParams = useSearchParams();
	const [reference, setReference] = useState(searchParams.get("reference") ?? "");
	const [referenceDraft, setReferenceDraft] = useState(reference);
	const canRefund = capabilities.data?.permissions.includes("admin.payments.refund") ?? false;
	const canAdjust = capabilities.data?.permissions.includes("admin.credits.write") ?? false;
	const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
	const [page, setPage] = useState(0);
	const orders = useAdminOperation<AdminBillingOrdersResult>("orders_list", {
		limit: 30,
		...(cursors[page] ? { cursor: cursors[page] } : {}),
		...(reference ? { reference } : {}),
	});
	const [selected, setSelected] = useState<AdminBillingOrder | null>(null);
	return (
		<div className="space-y-6">
			<CapabilitySection title={t("title")} description={t("description")}>
				<form
					className="gap-3 flex flex-wrap items-end"
					onSubmit={(event) => {
						event.preventDefault();
						setReference(referenceDraft.trim());
						setPage(0);
						setCursors([undefined]);
					}}
				>
					<label className="space-y-1 text-sm">
						<span>{t("reference")}</span>
						<Input
							value={referenceDraft}
							onChange={(event) => setReferenceDraft(event.target.value)}
							maxLength={200}
						/>
					</label>
					<Button type="submit" variant="outline">
						{common("apply")}
					</Button>
				</form>
				<Button
					variant="outline"
					size="sm"
					onClick={() => orders.refetch()}
					disabled={orders.isFetching}
				>
					{common("refresh")}
				</Button>
				<CapabilityError error={orders.error} />
				<CapabilityLoading loading={orders.isPending} empty={orders.data?.items.length === 0} />
				{orders.data && (
					<div className="overflow-x-auto">
						<table className="text-sm w-full text-left">
							<thead>
								<tr className="border-b">
									{(
										[
											"order",
											"owner",
											"provider",
											"amount",
											"remaining",
											"status",
											"actions",
										] as const
									).map((key) => (
										<th className="p-3" key={key}>
											{t(key)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{orders.data.items.map((order) => (
									<tr key={order.orderNo} className="border-b align-top">
										<td className="max-w-48 p-3 font-mono break-all">
											{order.orderNo}
											<p className="font-sans text-xs text-muted-foreground">{order.productKind}</p>
										</td>
										<td className="max-w-40 p-3 break-all">
											{order.ownerType}
											<br />
											{order.ownerId}
										</td>
										<td className="p-3">{order.provider}</td>
										<td className="p-3 whitespace-nowrap">
											{moneyMicros(order.amountMicros, order.currency, locale)}
										</td>
										<td className="p-3 whitespace-nowrap">
											{moneyMicros(order.remainingAmountMicros, order.currency, locale)}
										</td>
										<td className="max-w-48 p-3">
											{order.refundStatus ?? common("none")}
											{order.blockedReason && (
												<p className="mt-1 text-xs break-all text-muted-foreground">
													{order.blockedReason}
												</p>
											)}
										</td>
										<td className="p-3">
											{canRefund && (order.canRefund || order.refundRequestId) && (
												<Button size="sm" variant="outline" onClick={() => setSelected(order)}>
													{order.canRefund ? t("reviewRefund") : t("reconcile")}
												</Button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<div className="gap-3 flex justify-between">
					<Button
						size="sm"
						variant="outline"
						disabled={page === 0}
						onClick={() => setPage(page - 1)}
					>
						{common("previous")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!orders.data?.nextCursor}
						onClick={() => {
							if (!orders.data?.nextCursor) return;
							setCursors((current) => [
								...current.slice(0, page + 1),
								orders.data?.nextCursor ?? undefined,
							]);
							setPage(page + 1);
						}}
					>
						{common("next")}
					</Button>
				</div>
			</CapabilitySection>
			{canAdjust && <CreditsAdjustment />}
			{selected && (
				<RefundDialog
					key={selected.orderNo}
					order={selected}
					close={() => setSelected(null)}
					refresh={() => {
						void orders.refetch();
					}}
				/>
			)}
		</div>
	);
}

const creditSchema = z.object({
	ownerType: z.enum(["USER", "ORGANIZATION"]),
	ownerId: z.string().trim().min(1).max(200),
	action: z.enum(["grant", "deduct"]),
	credits: z.number().int().min(1).max(1_000_000_000),
	reason: z.string().trim().min(1).max(500),
});
type CreditInput = z.infer<typeof creditSchema>;

function CreditsAdjustment() {
	const t = useTranslations("admin.capabilities.payments");
	const common = useTranslations("admin.capabilities.common");
	const [confirmed, setConfirmed] = useState(false);
	const form = useForm<CreditInput>({
		resolver: zodResolver(creditSchema),
		defaultValues: { ownerType: "USER", ownerId: "", action: "grant", credits: 1, reason: "" },
	});
	const write = useAdminOperationWrite<
		CreditInput,
		{
			accountId: string;
			entryId: string;
			action: "grant" | "deduct";
			amount: string;
			spendableCredits: string;
			creditDebt: string;
		}
	>("credits_adjust");
	return (
		<CapabilitySection title={t("creditsTitle")} description={t("creditsDescription")}>
			<form
				className="space-y-4"
				onSubmit={form.handleSubmit(async (input) => {
					if (confirmed) await write.submit(input);
				})}
			>
				<fieldset disabled={write.locked} className="gap-3 sm:grid-cols-2 grid">
					<CapabilitySelect
						label={t("ownerType")}
						value={form.watch("ownerType")}
						onChange={(value) => {
							form.setValue("ownerType", value);
							setConfirmed(false);
						}}
						options={["USER", "ORGANIZATION"].map((value) => ({
							value: value as CreditInput["ownerType"],
							label: t(value === "USER" ? "user" : "organization"),
						}))}
					/>
					<label className="space-y-1 text-sm">
						<span>{t("ownerId")}</span>
						<Input
							required
							{...form.register("ownerId", { onChange: () => setConfirmed(false) })}
						/>
					</label>
					<CapabilitySelect
						label={t("creditAction")}
						value={form.watch("action")}
						onChange={(value) => {
							form.setValue("action", value);
							setConfirmed(false);
						}}
						options={["grant", "deduct"].map((value) => ({
							value: value as CreditInput["action"],
							label: t(value as "grant" | "deduct"),
						}))}
					/>
					<label className="space-y-1 text-sm">
						<span>{t("credits")}</span>
						<Input
							type="number"
							min={1}
							max={1_000_000_000}
							required
							{...form.register("credits", {
								valueAsNumber: true,
								onChange: () => setConfirmed(false),
							})}
						/>
					</label>
					<label className="space-y-1 text-sm sm:col-span-2">
						<span>{t("reason")}</span>
						<Textarea
							required
							maxLength={500}
							{...form.register("reason", { onChange: () => setConfirmed(false) })}
						/>
					</label>
					<label className="gap-2 text-sm sm:col-span-2 flex items-start">
						<input
							type="checkbox"
							className="mt-1"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						<span>
							{t("confirmCredits", {
								action: t(form.watch("action")),
								credits: form.watch("credits") || 0,
								owner: form.watch("ownerId") || "—",
							})}
						</span>
					</label>
				</fieldset>
				{Object.keys(form.formState.errors).length > 0 && (
					<p role="alert" className="text-sm text-destructive">
						{common("invalid")}
					</p>
				)}
				<CapabilityError error={write.error} uncertain={write.uncertain} />
				{write.isSuccess && (
					<div aria-live="polite" className="space-y-2 p-3 text-sm rounded-lg border">
						<p>
							{common("saved")} {common("execution")}: <code>{write.data.executionId}</code>
						</p>
						<p>
							{t("spendable")}: {write.data.result.spendableCredits} · {t("debt")}:{" "}
							{write.data.result.creditDebt}
						</p>
						<p>
							{t("ledgerEntry")}: <code>{write.data.result.entryId}</code>
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								write.reset();
								form.reset();
								setConfirmed(false);
							}}
						>
							{t("newAdjustment")}
						</Button>
					</div>
				)}
				<Button type="submit" disabled={!confirmed || write.locked || write.isSuccess}>
					{write.isPending ? common("saving") : t("adjustCredits")}
				</Button>
			</form>
		</CapabilitySection>
	);
}
