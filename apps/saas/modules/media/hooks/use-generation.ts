"use client";

import {
	captureBrowserGrowthAnalyticsAttribution,
	type GrowthAnalyticsAttributionSnapshot,
} from "@repo/utils";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { creditAccountQueryKey, creditAccountQueryOptions } from "../lib/credit-account-query";
import { createEditorActionController, type EditorQuoteRequest } from "../lib/editor-action";
import { getEditorErrorKey } from "../lib/editor-error";
import { isEditorProductKey, type EditorProductKey } from "../lib/editor-recovery";
import type { GenerationInput } from "../lib/form-schema";
import { recordGenerationAccepted } from "../lib/preview-timing";

type EditorQuote = { id: string; productKey: EditorProductKey; credits: string; expiresAt: string };
type GenerationResult = Awaited<ReturnType<typeof orpcClient.media.createGeneration>>;
type GenerationSubmission = {
	productKey: EditorProductKey;
	input: GenerationInput;
	expectedCredits: string;
	temporaryReferenceToken?: string;
};

export function useGeneration({
	parentJobId,
	ownerId = null,
}: { parentJobId?: string | null; ownerId?: string | null } = {}) {
	const queryClient = useQueryClient();
	const action = useRef<ReturnType<typeof createEditorActionController> | null>(null);
	action.current ??= createEditorActionController();
	const [ownedQuote, setOwnedQuote] = useState<{
		ownerId: string | null;
		value: EditorQuote;
	} | null>(null);
	const setQuote = (value: EditorQuote | null) => setOwnedQuote(value ? { ownerId, value } : null);
	const quote = ownedQuote?.ownerId === ownerId ? ownedQuote.value : null;
	const pendingSubmission = useRef<Promise<GenerationResult | null> | null>(null);
	const submissionAttribution = useRef<{
		key: string;
		snapshot: GrowthAnalyticsAttributionSnapshot;
	} | null>(null);
	const currentOwner = useRef(ownerId);
	if (currentOwner.current !== ownerId) {
		// Invalidate immediately during the owner render, before an old request resumes.
		currentOwner.current = ownerId;
		action.current.invalidate();
		pendingSubmission.current = null;
		submissionAttribution.current = null;
	}
	useEffect(() => {
		currentOwner.current = ownerId;
		return () => {
			action.current!.invalidate();
			currentOwner.current = null;
		};
	}, []); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps
	const catalog = useQuery({
		queryKey: ["media-catalog"],
		queryFn: () => orpcClient.media.getPublicCatalog(),
		staleTime: 5 * 60_000,
	});
	const creditAccount = useQuery(creditAccountQueryOptions(ownerId));
	const createQuote = useMutation({
		mutationFn: async (input: {
			productKey: EditorProductKey;
			input: GenerationInput;
			temporaryReferenceToken?: string;
		}) => {
			const attribution = captureBrowserGrowthAnalyticsAttribution();
			const request = action.current!.beginQuoteRequest();
			const value = await orpcClient.media.createQuote({
				...input,
				...(parentJobId ? { parentJobId } : {}),
			});
			const productKey = requireEditorProductKey(value.productKey);
			return { request, value: { ...value, productKey }, attribution };
		},
		onSuccess: ({ request, value, attribution }) => {
			if (action.current!.acceptQuote(request)) {
				setQuote(value);
				void saasGrowthFunnel.quoteCreated(
					value.id,
					value.productKey,
					Number(value.credits),
					attribution,
				);
			}
		},
	});
	const generationMutation = useMutation({
		mutationFn: async ({
			submission,
			submissionOwner,
			request,
		}: {
			submission: GenerationSubmission;
			submissionOwner: string | null;
			request: EditorQuoteRequest;
		}) => {
			if (
				!submissionOwner ||
				currentOwner.current !== submissionOwner ||
				!action.current!.acceptQuote(request)
			)
				return null;
			if (pendingSubmission.current) return pendingSubmission.current;
			const idempotencyKey = action.current!.idempotencyKeyFor("submission");
			if (submissionAttribution.current?.key !== idempotencyKey) {
				submissionAttribution.current = {
					key: idempotencyKey,
					snapshot: captureBrowserGrowthAnalyticsAttribution(),
				};
			}
			const attribution = submissionAttribution.current.snapshot;
			const submit = async () => {
				// The server owns the frozen quote and price check. Preserve the same key
				// after a lost response; settings changes explicitly start a new action.
				const submissionStartedAt = performance.now();
				const result = await orpcClient.media
					.submitGeneration({
						...submission,
						idempotencyKey,
						...(parentJobId ? { parentJobId } : {}),
					})
					.catch((error: unknown) => {
						// An expired, unused quote cannot create a job. Only the next manual
						// retry gets a fresh key; uncertain requests keep their original key.
						if (
							action.current!.acceptQuote(request) &&
							getEditorErrorKey(error) === "quoteExpired"
						) {
							action.current!.invalidate();
							setQuote(null);
						}
						throw error;
					});
				const productKey = requireEditorProductKey(result.quote.productKey);
				void saasGrowthFunnel.quoteCreated(
					result.quote.id,
					productKey,
					Number(result.quote.credits),
					attribution,
				);
				void saasGrowthFunnel.generationConfirmed(
					result.quote.id,
					productKey,
					result.job.id,
					attribution,
				);
				if (!action.current!.acceptQuote(request)) return null;
				recordGenerationAccepted(result.job.id, submissionStartedAt);
				setQuote({ ...result.quote, productKey });
				return { job: result.job, replayed: result.replayed };
			};
			const pending = submit();
			pendingSubmission.current = pending;
			try {
				return await pending;
			} finally {
				if (pendingSubmission.current === pending) pendingSubmission.current = null;
			}
		},
		onSettled: (_result, _error, { submissionOwner }) => {
			if (!submissionOwner) return;
			void refreshGenerationQueries(
				queryClient,
				submissionOwner,
				currentOwner.current === submissionOwner,
			).catch(() => {
				// Query observers retain refresh errors. An accepted job stays accepted.
			});
		},
	});
	const createGeneration = {
		...generationMutation,
		mutateAsync: (submission: GenerationSubmission) =>
			generationMutation.mutateAsync({
				submission,
				submissionOwner: ownerId,
				request: action.current!.beginQuoteRequest(),
			}),
	};
	useEffect(() => {
		setQuote(null);
		createQuote.reset();
		createGeneration.reset();
	}, [ownerId]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps
	function beginNewAction() {
		action.current!.invalidate();
		setQuote(null);
		createQuote.reset();
		if (!pendingSubmission.current) createGeneration.reset();
	}
	return { catalog, creditAccount, quote, createQuote, createGeneration, beginNewAction };
}

export async function refreshGenerationQueries(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	ownerId: string | null,
	refreshHistory = true,
): Promise<void> {
	await Promise.all([
		...(refreshHistory ? [queryClient.invalidateQueries({ queryKey: ["media-jobs"] })] : []),
		...(ownerId
			? [
					queryClient.invalidateQueries({
						queryKey: creditAccountQueryKey(ownerId),
						exact: true,
						...(refreshHistory ? {} : { refetchType: "none" as const }),
					}),
				]
			: []),
	]);
}

export function requireEditorProductKey(productKey: string): EditorProductKey {
	if (isEditorProductKey(productKey)) return productKey;
	throw new Error("PRODUCT_UNAVAILABLE");
}
