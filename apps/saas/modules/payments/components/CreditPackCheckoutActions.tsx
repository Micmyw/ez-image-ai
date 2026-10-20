"use client";

import { useSessionQuery } from "@auth/lib/api";
import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";
import { useRouter } from "@shared/hooks/router";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	captureCheckoutTrigger,
	clearCheckoutTrigger,
	getCurrentCheckoutAttribution,
} from "@shared/lib/purchase-attribution";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { bindVideoEffectPaymentReturn } from "../../video-effects/lib/payment-return";
import { usePaymentAction } from "../hooks/use-payment-action";
import {
	clearCreditPackCheckoutContext,
	readCreditPackCheckoutContext,
	saveCreditPackCheckoutContext,
} from "../lib/credit-pack-checkout-context";
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
	const session = useSessionQuery();
	const user = session.data?.user;
	const ownerId = user && !user.isAnonymous ? user.id : undefined;
	const organizationId = session.data?.session?.activeOrganizationId ?? null;
	const scope = ownerId ? JSON.stringify([ownerId, organizationId]) : null;
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const currentPayment = useRef(payment);
	currentPayment.current = payment;
	const mounted = useRef(true);
	const inflight = useRef<symbol | null>(null);
	const ownedAction = useRef<ReturnType<typeof payment.getSnapshot>>(null);
	const attemptScope = useRef(scope);
	const previousScope = useRef(scope);
	const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
	const checkoutAttempts = useRef(
		createCreditPackCheckoutAttemptController(createCheckoutAttemptKey),
	);
	if (attemptScope.current !== scope) {
		attemptScope.current = scope;
		checkoutAttempts.current = createCreditPackCheckoutAttemptController(createCheckoutAttemptKey);
	}
	const [recovery, setRecovery] = useState<{ scope: string; intentId: string } | null>(null);
	const recoveryIntentId = recovery?.scope === scope ? recovery.intentId : undefined;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const action = currentPayment.current;
			if (inflight.current && ownedAction.current && action.getSnapshot() === ownedAction.current)
				action.release();
			ownedAction.current = null;
		};
	}, []);
	useEffect(() => {
		if (previousScope.current === scope) return;
		previousScope.current = scope;
		const action = currentPayment.current;
		if (inflight.current && ownedAction.current && action.getSnapshot() === ownedAction.current)
			action.release();
		inflight.current = null;
		ownedAction.current = null;
		setCheckoutUnavailable(false);
	}, [scope, packKey]);
	useEffect(() => {
		const intentId = ownerId
			? readCreditPackCheckoutContext(ownerId, organizationId, packKey)
			: undefined;
		setRecovery(scope && intentId ? { scope, intentId } : null);
	}, [scope, ownerId, organizationId, packKey]);
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
			const action = currentPayment.current;
			if (
				action.action?.key.startsWith(`pack:${packKey}:`) &&
				action.action.stage === "redirecting"
			)
				action.release();
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
	const createCheckout = useMutation(orpc.payments.createCreditPackCheckout.mutationOptions());
	const options = useContext(CreditPackPaymentContext);
	const provider = options?.provider ?? null;
	const availability = options?.availability.get(packKey);
	const canPay = Boolean(
		provider && availability?.ready && availability.providers.includes(provider),
	);
	const processing = payment.action?.key.startsWith(`pack:${packKey}:`);

	async function beginCheckout(provider: CreditPackCheckoutProvider) {
		if (!canPay || inflight.current) return;
		if (!ownerId || !scope) {
			router.push("/signup?redirectTo=%2Fpricing");
			return;
		}
		if (!payment.acquire(`pack:${packKey}:${provider}`)) return;
		const action = payment.getSnapshot();
		ownedAction.current = action;
		const request = Symbol("credit-pack-checkout");
		inflight.current = request;
		captureCheckoutTrigger();
		const selection: CreditPackCheckoutSelection = { packKey, provider };
		const idempotencyKey = checkoutAttempts.current.begin(selection);
		setCheckoutUnavailable(false);
		const originatingPath = window.location.pathname + window.location.search;

		try {
			const attribution = await getCurrentCheckoutAttribution();
			if (
				!mounted.current ||
				currentScope.current !== scope ||
				inflight.current !== request ||
				payment.getSnapshot() !== action
			)
				return;
			const { checkoutLink, intentId } = await createCheckout.mutateAsync({
				provider,
				packKey,
				idempotencyKey,
				attribution,
			});
			if (
				!mounted.current ||
				currentScope.current !== scope ||
				inflight.current !== request ||
				payment.getSnapshot() !== action
			)
				return;
			checkoutAttempts.current.succeeded(selection);
			clearCheckoutTrigger();
			saveCreditPackCheckoutContext(ownerId, organizationId, packKey, intentId);
			setRecovery({ scope, intentId });
			bindVideoEffectPaymentReturn(ownerId, intentId, originatingPath);
			payment.redirecting();
			window.location.href = checkoutLink;
		} catch (error) {
			if (!mounted.current || currentScope.current !== scope || inflight.current !== request)
				return;
			if (payment.getSnapshot() === action) payment.release();
			if (getErrorCode(error) === "UNAUTHORIZED") {
				router.push("/signup?redirectTo=%2Fpricing");
				return;
			}
			setCheckoutUnavailable(true);
		} finally {
			if (payment.getSnapshot() === action) payment.release();
			if (inflight.current === request) inflight.current = null;
			if (ownedAction.current === action) ownedAction.current = null;
		}
	}

	return (
		<div className="pt-5 mt-auto">
			<button
				type="button"
				data-testid={`credit-pack-buy-${packKey}`}
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
