"use client";

import type { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
	clearCreditPackCheckoutContext,
	readCreditPackCheckoutContext,
} from "../lib/credit-pack-checkout-context";

export function CreditPackCheckoutRecovery({
	ownerId,
	organizationId,
	packKey,
	createdIntentId,
}: {
	ownerId: string;
	organizationId: string | null;
	packKey: (typeof PUBLIC_CREDIT_PACKS)[number]["packKey"];
	createdIntentId?: string;
}) {
	const t = useTranslations();
	const scope = JSON.stringify([ownerId, organizationId, packKey]);
	const [recovery, setRecovery] = useState<{ scope: string; intentId: string } | null>(null);
	const recoveryIntentId = recovery?.scope === scope ? recovery.intentId : undefined;
	useEffect(() => {
		const intentId =
			createdIntentId || readCreditPackCheckoutContext(ownerId, organizationId, packKey);
		setRecovery(scope && intentId ? { scope, intentId } : null);
	}, [scope, ownerId, organizationId, packKey, createdIntentId]);
	const recoveryState = useQuery({
		...orpc.payments.getCreditPackCheckoutState.queryOptions({
			input: { intentId: recoveryIntentId ?? "" },
		}),
		queryKey: ["credit-pack-checkout", ownerId, organizationId, recoveryIntentId],
		enabled: Boolean(ownerId && recoveryIntentId),
		refetchInterval: false,
	});
	const refreshRecovery = recoveryState.refetch;
	useEffect(() => {
		const restore = () => {
			if (!ownerId || !scope) return;
			const intentId = readCreditPackCheckoutContext(ownerId, organizationId, packKey);
			setRecovery(intentId ? { scope, intentId } : null);
			if (intentId && intentId === recoveryIntentId) void refreshRecovery();
		};
		window.addEventListener("pageshow", restore);
		window.addEventListener("focus", restore);
		return () => {
			window.removeEventListener("pageshow", restore);
			window.removeEventListener("focus", restore);
		};
	}, [ownerId, organizationId, scope, packKey, recoveryIntentId, refreshRecovery]);
	useEffect(() => {
		if (
			ownerId &&
			recoveryIntentId &&
			recoveryState.isSuccess &&
			(recoveryState.data?.status === "COMPLETED" ||
				recoveryState.data?.status === "EXPIRED" ||
				recoveryState.data?.status === "CANCELED")
		)
			clearCreditPackCheckoutContext(ownerId, organizationId, recoveryIntentId);
	}, [
		ownerId,
		organizationId,
		recoveryIntentId,
		recoveryState.isSuccess,
		recoveryState.data?.status,
	]);
	return (
		<>
			{recoveryIntentId && (
				<div
					className="mt-3 space-y-2 text-xs text-center text-[#cfc1e8]"
					data-testid={`credit-pack-recovery-${packKey}`}
				>
					<p aria-live="polite">
						{t(
							recoveryState.isError
								? "creditPackCheckoutReturn.error"
								: recoveryState.data?.status === "COMPLETED"
									? "creditPackCheckoutReturn.completed"
									: recoveryState.data?.status === "REVIEW"
										? "creditPackCheckoutReturn.review"
										: recoveryState.data?.status === "EXPIRED" ||
											  recoveryState.data?.status === "CANCELED"
											? "creditPackCheckoutReturn.notCompleted"
											: "creditPackCheckoutReturn.pending",
						)}
					</p>
					<Link
						href={`/credit-pack-checkout-return?intentId=${encodeURIComponent(recoveryIntentId)}`}
						className="min-h-9 inline-flex items-center underline underline-offset-4"
					>
						{t("creditPackCheckoutReturn.viewStatus")}
					</Link>
				</div>
			)}
		</>
	);
}
