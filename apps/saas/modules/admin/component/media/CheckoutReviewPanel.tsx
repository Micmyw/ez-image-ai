"use client";

import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

export function CheckoutReviewPanel() {
	const t = useTranslations("admin.media.checkoutReview");
	const pricing = useTranslations("pricing");
	const fieldId = useId();
	const [reference, setReference] = useState("");
	const [selectedId, setSelectedId] = useState("");
	const query = useQuery({
		...orpc.payments.getAdminCheckoutReview.queryOptions({
			input: { checkoutIntentId: selectedId },
		}),
		enabled: Boolean(selectedId),
		retry: false,
		refetchOnWindowFocus: false,
	});
	const review = query.data;
	return (
		<Card className="space-y-4 p-5" id="checkout-review">
			<h2 className="text-xl font-semibold">{t("title")}</h2>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					const id = reference.trim();
					if (!id) return;
					if (id === selectedId) void query.refetch();
					else setSelectedId(id);
				}}
			>
				<label className="text-sm font-medium" htmlFor={fieldId}>
					{t("reference")}
				</label>
				<div className="gap-2 flex flex-wrap">
					<Input
						id={fieldId}
						value={reference}
						maxLength={128}
						required
						className="min-w-0 flex-1"
						onChange={(event) => setReference(event.target.value)}
					/>
					<Button
						type="submit"
						variant="outline"
						disabled={!reference.trim() || query.isFetching}
						loading={query.isFetching}
					>
						{t("load")}
					</Button>
				</div>
			</form>
			{query.isError && (
				<p role="alert" className="text-sm text-destructive">
					{t("loadError")}
				</p>
			)}
			{review && !query.isError && (
				<div className="space-y-4">
					<dl className="gap-3 text-sm sm:grid-cols-2 grid">
						<div>
							<dt className="text-muted-foreground">{t("reference")}</dt>
							<dd className="break-all">{review.id}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">{t("owner")}</dt>
							<dd className="break-all">
								{review.ownerType}: {review.ownerId}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">{t("plan")}</dt>
							<dd>
								{["creator", "ultimate", "studio"].includes(review.planId)
									? pricing(`products.${review.planId}.title`)
									: review.planId}{" "}
								· {pricing(review.interval === "year" ? "yearly" : "monthly")}
							</dd>
						</div>
					</dl>
					{review.recoveryStatus === "CLOSED" ? (
						<output className="text-sm block">{t("closed")}</output>
					) : review.canReview && review.updatedAt ? (
						<CheckoutReviewForm
							key={`${review.id}:${review.updatedAt}`}
							id={review.id}
							updatedAt={review.updatedAt}
							disabled={query.isFetching}
						/>
					) : (
						<output className="text-sm block">{t("notEligible")}</output>
					)}
				</div>
			)}
		</Card>
	);
}

function CheckoutReviewForm({
	id,
	updatedAt,
	disabled,
}: {
	id: string;
	updatedAt: string;
	disabled: boolean;
}) {
	const t = useTranslations("admin.media.checkoutReview");
	const fieldId = useId();
	const queryClient = useQueryClient();
	const [reason, setReason] = useState("");
	const [evidenceReference, setEvidenceReference] = useState("");
	const [customerConfirmed, setCustomerConfirmed] = useState(false);
	const [merchantReviewed, setMerchantReviewed] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const operation = useRef({ signature: "", key: "" });
	const busy = useRef(false);
	const action = useMutation(orpc.payments.resolveAdminCheckoutReview.mutationOptions());
	const canSubmit =
		customerConfirmed &&
		merchantReviewed &&
		reason.trim().length >= 10 &&
		evidenceReference.trim().length >= 10;
	async function submit() {
		if (!canSubmit || busy.current || disabled) return;
		busy.current = true;
		setErrorCode(null);
		const signature = JSON.stringify([id, updatedAt, reason.trim(), evidenceReference.trim()]);
		if (operation.current.signature !== signature)
			operation.current = { signature, key: crypto.randomUUID() };
		try {
			const result = await action.mutateAsync({
				checkoutIntentId: id,
				expectedUpdatedAt: updatedAt,
				operationKey: operation.current.key,
				reason: reason.trim(),
				evidenceReference: evidenceReference.trim(),
				customerConfirmedNoApproval: true,
				merchantRecordsReviewed: true,
			});
			queryClient.setQueryData(
				orpc.payments.getAdminCheckoutReview.queryOptions({ input: { checkoutIntentId: id } })
					.queryKey,
				result,
			);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.payments.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.media.listMediaAuditLog.key() }),
			]);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			setErrorCode(t.has(`errors.${message}`) ? message : "CHECKOUT_REVIEW_FAILED");
		} finally {
			busy.current = false;
		}
	}
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<fieldset disabled={disabled || action.isPending} className="space-y-4">
				<legend className="mb-3 text-sm font-medium">{t("evidence")}</legend>
				<label className="gap-2 text-sm flex items-start">
					<input
						type="checkbox"
						required
						checked={customerConfirmed}
						onChange={(event) => setCustomerConfirmed(event.target.checked)}
						className="mt-1 size-4 shrink-0"
					/>
					{t("customerConfirmed")}
				</label>
				<label className="gap-2 text-sm flex items-start">
					<input
						type="checkbox"
						required
						checked={merchantReviewed}
						onChange={(event) => setMerchantReviewed(event.target.checked)}
						className="mt-1 size-4 shrink-0"
					/>
					{t("merchantReviewed")}
				</label>
				<div className="space-y-2">
					<label className="text-sm font-medium" htmlFor={`${fieldId}-evidence`}>
						{t("evidenceReference")}
					</label>
					<Input
						id={`${fieldId}-evidence`}
						required
						minLength={10}
						maxLength={500}
						value={evidenceReference}
						onChange={(event) => setEvidenceReference(event.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<label className="text-sm font-medium" htmlFor={`${fieldId}-reason`}>
						{t("reason")}
					</label>
					<Textarea
						id={`${fieldId}-reason`}
						required
						minLength={10}
						maxLength={500}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
					/>
				</div>
				<p className="text-sm text-muted-foreground">{t("decisionHint")}</p>
				<Button
					type="submit"
					disabled={!canSubmit || action.isPending || disabled}
					loading={action.isPending}
				>
					{t("close")}
				</Button>
				{action.isPending && <output className="text-sm block">{t("checking")}</output>}
			</fieldset>
			{errorCode && (
				<p role="alert" className="mt-3 text-sm text-destructive">
					{t(`errors.${errorCode}`)}
				</p>
			)}
		</form>
	);
}
