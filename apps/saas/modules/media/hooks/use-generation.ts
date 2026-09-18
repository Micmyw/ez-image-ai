"use client";

import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { createEditorActionController, type EditorQuoteRequest } from "../lib/editor-action";
import { isEditorProductKey, type EditorProductKey } from "../lib/editor-recovery";
import type { GenerationInput } from "../lib/form-schema";

type EditorQuote = { id: string; productKey: EditorProductKey; credits: string; expiresAt: string };
type GenerationResult = Awaited<ReturnType<typeof orpcClient.media.createGeneration>>;

export function useGeneration({ parentJobId }: { parentJobId?: string | null } = {}) {
	const queryClient = useQueryClient();
	const action = useRef<ReturnType<typeof createEditorActionController> | null>(null);
	action.current ??= createEditorActionController();
	const [quote, setQuote] = useState<EditorQuote | null>(null);
	const cachedQuote = useRef<{
		request: EditorQuoteRequest;
		value: EditorQuote;
		submitted: boolean;
	} | null>(null);
	const pendingSubmission = useRef<Promise<GenerationResult | null> | null>(null);
	const catalog = useQuery({
		queryKey: ["media-catalog"],
		queryFn: () => orpcClient.media.getPublicCatalog(),
		staleTime: 5 * 60_000,
	});
	const creditAccount = useQuery({
		queryKey: ["media-credit-account"],
		queryFn: () => orpcClient.media.getCreditAccount(),
	});
	const createQuote = useMutation({
		mutationFn: async (input: { productKey: EditorProductKey; input: GenerationInput }) => {
			const request = action.current!.beginQuoteRequest();
			const value = await orpcClient.media.createQuote({
				...input,
				...(parentJobId ? { parentJobId } : {}),
			});
			const productKey = requireEditorProductKey(value.productKey);
			return { request, value: { ...value, productKey } };
		},
		onSuccess: ({ request, value }) => {
			if (action.current!.acceptQuote(request)) {
				cachedQuote.current = { request, value, submitted: false };
				setQuote(value);
				void saasGrowthFunnel.quoteCreated(value.id, value.productKey, Number(value.credits));
			}
		},
	});
	const createGeneration = useMutation({
		mutationFn: async (submission: {
			productKey: EditorProductKey;
			input: GenerationInput;
			expectedCredits: string;
		}) => {
			if (pendingSubmission.current) return pendingSubmission.current;
			const submit = async () => {
				let approved = cachedQuote.current;
				// Preserve an uncertain submission's quote/key. Never automatically create another job.
				if (
					!approved ||
					!action.current!.acceptQuote(approved.request) ||
					(!approved.submitted && Date.parse(approved.value.expiresAt) <= Date.now())
				) {
					const response = await createQuote.mutateAsync({
						productKey: submission.productKey,
						input: submission.input,
					});
					if (!action.current!.acceptQuote(response.request)) return null;
					approved = cachedQuote.current;
				}
				if (!approved || !action.current!.acceptQuote(approved.request)) return null;
				if (approved.value.productKey !== submission.productKey)
					throw new Error("PRODUCT_UNAVAILABLE");
				if (approved.value.credits !== submission.expectedCredits) throw new Error("PRICE_CHANGED");
				approved.submitted = true;
				void saasGrowthFunnel.generationConfirmed(approved.value.id, approved.value.productKey);
				return orpcClient.media.createGeneration({
					quoteId: approved.value.id,
					idempotencyKey: action.current!.idempotencyKeyFor(approved.value.id),
					...(parentJobId ? { parentJobId } : {}),
				});
			};
			pendingSubmission.current = submit();
			try {
				return await pendingSubmission.current;
			} finally {
				pendingSubmission.current = null;
			}
		},
		onSettled: () => refreshGenerationQueries(queryClient),
	});
	function beginNewAction() {
		action.current!.invalidate();
		cachedQuote.current = null;
		setQuote(null);
		createQuote.reset();
		if (!pendingSubmission.current) createGeneration.reset();
	}
	return { catalog, creditAccount, quote, createQuote, createGeneration, beginNewAction };
}

export async function refreshGenerationQueries(
	queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
	await Promise.all([
		queryClient.invalidateQueries({ queryKey: ["media-jobs"] }),
		queryClient.invalidateQueries({ queryKey: ["media-credit-account"] }),
	]);
}

export function requireEditorProductKey(productKey: string): EditorProductKey {
	if (isEditorProductKey(productKey)) return productKey;
	throw new Error("PRODUCT_UNAVAILABLE");
}
