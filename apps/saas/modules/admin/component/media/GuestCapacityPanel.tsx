"use client";

import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { DiagnosticsStatus } from "./DiagnosticsStatus";

export function GuestCapacityPanel() {
	const t = useTranslations("admin.media.guestCapacity");
	const fieldId = useId();
	const queryClient = useQueryClient();
	const query = useQuery(
		orpc.media.adminGuestCapacity.queryOptions({
			staleTime: 60_000,
			refetchInterval: 60_000,
			refetchIntervalInBackground: false,
		}),
	);
	const action = useMutation(orpc.media.setGuestPrincipalCapacity.mutationOptions());
	const [draftLimit, setDraftLimit] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	const [status, setStatus] = useState<"saved" | "saveError" | null>(null);
	const operation = useRef({ signature: "", key: "" });
	const busy = useRef(false);
	const capacity = query.data;
	const limitValue = draftLimit ?? String(capacity?.maximumTemporaryPrincipals ?? "");
	const maximumTemporaryPrincipals = Number(limitValue);
	const validLimit =
		Number.isSafeInteger(maximumTemporaryPrincipals) && maximumTemporaryPrincipals > 0;
	const canSubmit =
		capacity &&
		!query.isError &&
		validLimit &&
		reason.trim().length >= 10 &&
		maximumTemporaryPrincipals !== capacity.maximumTemporaryPrincipals;

	async function submit() {
		if (!canSubmit || busy.current) return;
		busy.current = true;
		setStatus(null);
		const signature = JSON.stringify([maximumTemporaryPrincipals, reason.trim()]);
		if (operation.current.signature !== signature) {
			operation.current = { signature, key: crypto.randomUUID() };
		}
		try {
			const result = await action.mutateAsync({
				maximumTemporaryPrincipals,
				reason: reason.trim(),
				idempotencyKey: operation.current.key,
			});
			queryClient.setQueryData(orpc.media.adminGuestCapacity.queryOptions().queryKey, (current) =>
				current
					? {
							...current,
							maximumTemporaryPrincipals: result.maximumTemporaryPrincipals,
							version: result.version,
							source: "admin" as const,
							remaining: Math.max(0, result.maximumTemporaryPrincipals - current.used),
						}
					: current,
			);
			setDraftLimit(null);
			setReason("");
			setStatus("saved");
			operation.current = { signature: "", key: "" };
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.media.adminGuestCapacity.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.media.listMediaAuditLog.key() }),
			]);
		} catch {
			setStatus("saveError");
		} finally {
			busy.current = false;
		}
	}

	return (
		<Card className="space-y-4 p-5" id="guest-capacity">
			<h2 className="text-xl font-semibold">{t("title")}</h2>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			<DiagnosticsStatus title={t("title")} query={query} intervalMs={60_000} />
			{capacity && (
				<>
					<dl className="gap-4 text-sm sm:grid-cols-3 grid">
						{(
							[
								["limit", capacity.maximumTemporaryPrincipals],
								["used", capacity.used],
								["remaining", capacity.remaining],
							] as const
						).map(([label, value]) => (
							<div key={label}>
								<dt className="text-muted-foreground">{t(label)}</dt>
								<dd className="text-2xl font-semibold">{value}</dd>
							</div>
						))}
					</dl>
					<p className="text-sm text-muted-foreground">
						{t(capacity.source === "admin" ? "sourceAdmin" : "sourceEnvironment")} ·{" "}
						{t("leases", { count: capacity.activePrincipalLeases })}
					</p>
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						<div className="space-y-1">
							<label className="text-sm font-medium" htmlFor={`${fieldId}-limit`}>
								{t("limit")}
							</label>
							<Input
								id={`${fieldId}-limit`}
								type="number"
								min={1}
								max={Number.MAX_SAFE_INTEGER}
								step={1}
								required
								value={limitValue}
								disabled={query.isError || action.isPending}
								onChange={(event) => {
									setDraftLimit(event.target.value);
									setStatus(null);
								}}
							/>
						</div>
						{validLimit && maximumTemporaryPrincipals < capacity.used && (
							<p className="text-sm text-muted-foreground">{t("belowUsage")}</p>
						)}
						<div className="space-y-1">
							<label className="text-sm font-medium" htmlFor={`${fieldId}-reason`}>
								{t("reason")}
							</label>
							<Input
								id={`${fieldId}-reason`}
								value={reason}
								required
								minLength={10}
								maxLength={500}
								placeholder={t("reasonHint")}
								disabled={query.isError || action.isPending}
								onChange={(event) => {
									setReason(event.target.value);
									setStatus(null);
								}}
							/>
						</div>
						<Button
							type="submit"
							loading={action.isPending}
							disabled={!canSubmit || action.isPending}
						>
							{t("save")}
						</Button>
					</form>
				</>
			)}
			{status && (
				<p role={status === "saveError" ? "alert" : "status"} className="text-sm">
					{t(status)}
				</p>
			)}
		</Card>
	);
}
