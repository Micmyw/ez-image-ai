"use client";

import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import type { PaymentProviderName } from "@repo/payments/types";
import { useRouter } from "@shared/hooks/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import {
	createCreditPackCheckoutAttemptController,
	filterCreditPackCheckoutProviders,
	type CreditPackCheckoutProvider,
	type CreditPackCheckoutSelection,
} from "./checkout-attempt";

type PublicCreditPackKey = (typeof PUBLIC_CREDIT_PACKS)[number]["packKey"];

export function CreditPackCheckoutActions({
	active,
	packKey,
}: {
	active: boolean;
	packKey: PublicCreditPackKey;
}) {
	const t = useTranslations();
	const router = useRouter();
	const [loadingProvider, setLoadingProvider] = useState<CreditPackCheckoutProvider | null>(null);
	const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
	const checkoutAttempts = useRef(
		createCreditPackCheckoutAttemptController(createCheckoutAttemptKey),
	);
	const createCheckout = useMutation(orpc.payments.createCreditPackCheckout.mutationOptions());
	const availability = useQuery({
		...orpc.payments.getCreditPackProviderAvailability.queryOptions({ input: { packKey } }),
		enabled: active,
	});
	const providers = filterCreditPackCheckoutProviders(
		(availability.data?.providers ?? [])
			.filter(({ capabilities }) => capabilities.checkout)
			.map(({ name }) => name as PaymentProviderName),
	);

	async function beginCheckout(provider: CreditPackCheckoutProvider) {
		const selection: CreditPackCheckoutSelection = { packKey, provider };
		const idempotencyKey = checkoutAttempts.current.begin(selection);
		setCheckoutUnavailable(false);
		setLoadingProvider(provider);

		try {
			const { checkoutLink } = await createCheckout.mutateAsync({
				provider,
				packKey,
				idempotencyKey,
			});
			checkoutAttempts.current.succeeded(selection);
			window.location.href = checkoutLink;
		} catch (error) {
			if (getErrorCode(error) === "UNAUTHORIZED") {
				router.push("/signup?redirectTo=%2Fpricing");
				return;
			}
			setCheckoutUnavailable(true);
		} finally {
			setLoadingProvider(null);
		}
	}

	const unavailable =
		checkoutUnavailable ||
		availability.isError ||
		(!availability.isPending && providers.length === 0);

	return (
		<div className="pt-5 mt-auto">
			{availability.isPending && (
				<p className="text-xs text-center text-[#9f93aa]" aria-live="polite">
					{t("pricing.paymentOptionsLoading")}
				</p>
			)}
			{providers.length > 0 && (
				<div className="gap-2 grid grid-cols-2">
					{providers.map((provider) => (
						<button
							key={provider}
							type="button"
							disabled={loadingProvider !== null}
							onClick={() => void beginCheckout(provider)}
							className="border-white/12 bg-white/[0.065] min-h-11 gap-1.5 px-3 text-xs font-semibold text-white hover:bg-white/[0.1] focus-visible:outline-violet-200 inline-flex items-center justify-center rounded-xl border transition hover:border-[#b9a6ff]/45 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60"
						>
							{t("pricing.buyWith", {
								provider: t(`payments.providerSelector.providers.${provider}`),
							})}
							<ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
						</button>
					))}
				</div>
			)}
			{unavailable && (
				<p className="mt-2 text-xs leading-5 text-center text-[#ff9da8]" role="alert">
					{t("pricing.creditPackCheckoutUnavailable")}
				</p>
			)}
		</div>
	);
}

function createCheckoutAttemptKey(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}
