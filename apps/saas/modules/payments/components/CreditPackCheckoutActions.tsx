"use client";

import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import { useRouter } from "@shared/hooks/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueries } from "@tanstack/react-query";
import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";

import { usePaymentAction } from "../hooks/use-payment-action";
import {
	createCreditPackCheckoutAttemptController,
	filterCreditPackCheckoutProviders,
	type CreditPackCheckoutProvider,
	type CreditPackCheckoutSelection,
} from "./checkout-attempt";
import { PaymentProviderSelector } from "./PaymentProviderSelector";

type PublicCreditPackKey = (typeof PUBLIC_CREDIT_PACKS)[number]["packKey"];

const CreditPackPaymentContext = createContext<{
	provider: CreditPackCheckoutProvider | null;
	availability: Map<
		PublicCreditPackKey,
		{ providers: CreditPackCheckoutProvider[]; ready: boolean; failed: boolean }
	>;
} | null>(null);

export function CreditPackPaymentOptions({
	active,
	children,
}: {
	active: boolean;
	children: ReactNode;
}) {
	const t = useTranslations();
	const payment = usePaymentAction();
	const [selectedProvider, setSelectedProvider] = useState<CreditPackCheckoutProvider | null>(null);
	const queries = useQueries({
		queries: PUBLIC_CREDIT_PACKS.map(({ packKey }) => ({
			...orpc.payments.getCreditPackProviderAvailability.queryOptions({ input: { packKey } }),
			enabled: active,
			staleTime: 30_000,
			refetchInterval: active ? 30_000 : (false as const),
		})),
	});
	const loading = queries.some((query) => query.isPending);
	const availability = new Map(
		PUBLIC_CREDIT_PACKS.map(({ packKey }, index) => {
			const query = queries[index]!;
			return [
				packKey,
				{
					providers: filterCreditPackCheckoutProviders(
						(query.data?.providers ?? [])
							.filter(({ capabilities }) => capabilities.checkout)
							.map(({ name }) => name),
					),
					ready: !loading && !query.isError,
					failed: query.isError,
				},
			] as const;
		}),
	);
	const providers = [...new Set([...availability.values()].flatMap((entry) => entry.providers))];
	const provider = selectedProvider ?? providers[0] ?? null;
	return (
		<CreditPackPaymentContext.Provider value={{ provider, availability }}>
			<div className="credit-pack-payment-options min-h-24" aria-busy={loading}>
				{loading ? (
					<output className="min-h-24 text-sm flex items-center text-[#b8adbf]" aria-live="polite">
						{t("pricing.paymentOptionsLoading")}
					</output>
				) : providers.length ? (
					<PaymentProviderSelector
						name="credit-pack-provider"
						providers={providers}
						value={provider}
						onValueChange={(value) => {
							if (value === "paypal" || value === "waffo") setSelectedProvider(value);
						}}
						disabled={Boolean(payment.action)}
					/>
				) : (
					<p className="py-4 text-sm text-[#ff9da8]" role="alert">
						{t("pricing.creditPackCheckoutUnavailable")}
					</p>
				)}
			</div>
			{children}
		</CreditPackPaymentContext.Provider>
	);
}

export function CreditPackCheckoutActions({ packKey }: { packKey: PublicCreditPackKey }) {
	const t = useTranslations();
	const router = useRouter();
	const payment = usePaymentAction();
	const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
	const checkoutAttempts = useRef(
		createCreditPackCheckoutAttemptController(createCheckoutAttemptKey),
	);
	const createCheckout = useMutation(orpc.payments.createCreditPackCheckout.mutationOptions());
	const options = useContext(CreditPackPaymentContext);
	const provider = options?.provider ?? null;
	const availability = options?.availability.get(packKey);
	const canPay = Boolean(
		provider && availability?.ready && availability.providers.includes(provider),
	);
	const processing = payment.action?.key.startsWith(`pack:${packKey}:`);

	async function beginCheckout(provider: CreditPackCheckoutProvider) {
		if (!canPay) return;
		if (!payment.acquire(`pack:${packKey}:${provider}`)) return;
		const selection: CreditPackCheckoutSelection = { packKey, provider };
		const idempotencyKey = checkoutAttempts.current.begin(selection);
		setCheckoutUnavailable(false);

		try {
			const { checkoutLink } = await createCheckout.mutateAsync({
				provider,
				packKey,
				idempotencyKey,
			});
			checkoutAttempts.current.succeeded(selection);
			payment.redirecting();
			window.location.href = checkoutLink;
		} catch (error) {
			payment.release();
			if (getErrorCode(error) === "UNAUTHORIZED") {
				router.push("/signup?redirectTo=%2Fpricing");
				return;
			}
			setCheckoutUnavailable(true);
		}
	}

	return (
		<div className="pt-5 mt-auto">
			<button
				type="button"
				disabled={Boolean(payment.action) || !canPay}
				aria-busy={Boolean(processing)}
				onClick={() => provider && void beginCheckout(provider)}
				className="border-white/12 bg-white/[0.065] min-h-11 gap-2 px-4 text-sm font-semibold text-white hover:bg-white/[0.1] focus-visible:outline-violet-200 inline-flex w-full items-center justify-center rounded-xl border transition hover:border-[#b9a6ff]/45 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{processing
					? t(
							payment.action?.stage === "redirecting"
								? "pricing.upgrade.redirecting"
								: "pricing.upgrade.processing",
						)
					: t("pricing.buyCredits")}
				{processing ? (
					<Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
				) : (
					<ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
				)}
			</button>
			{(checkoutUnavailable || availability?.failed || (availability?.ready && !canPay)) && (
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
