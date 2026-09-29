"use client";

import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { createEditorActionController } from "../lib/editor-action";
import { getEditorErrorKey } from "../lib/editor-error";
import { isEditorProductKey, type EditorProductKey } from "../lib/editor-recovery";
import type { GenerationInput } from "../lib/form-schema";
import { recordGenerationAccepted } from "../lib/preview-timing";

type EditorQuote = { id: string; productKey: EditorProductKey; credits: string; expiresAt: string };
type GenerationResult = Awaited<ReturnType<typeof orpcClient.media.createGeneration>>;

export function useGeneration({ parentJobId }: { parentJobId?: string | null } = {}) {
	const queryClient = useQueryClient();
	const action = useRef<ReturnType<typeof createEditorActionController> | null>(null);
	action.current ??= createEditorActionController();
	const [quote, setQuote] = useState<EditorQuote | null>(null);
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
		mutationFn: async (input: {
			productKey: EditorProductKey;
			input: GenerationInput;
			temporaryReferenceToken?: string;
		}) => {
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
			temporaryReferenceToken?: string;
		}) => {
			if (pendingSubmission.current) return pendingSubmission.current;
			const submit = async () => {
				const request = action.current!.beginQuoteRequest();
				// The server owns the frozen quote and price check. Preserve the same key
				// after a lost response; settings changes explicitly start a new action.
				const submissionStartedAt = performance.now();
				const result = await orpcClient.media
					.submitGeneration({
						...submission,
						idempotencyKey: action.current!.idempotencyKeyFor("submission"),
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
				if (!action.current!.acceptQuote(request)) return null;
				recordGenerationAccepted(result.job.id, submissionStartedAt);
				const productKey = requireEditorProductKey(result.quote.productKey);
				setQuote({ ...result.quote, productKey });
				void saasGrowthFunnel.quoteCreated(
					result.quote.id,
					productKey,
					Number(result.quote.credits),
				);
				void saasGrowthFunnel.generationConfirmed(result.quote.id, productKey);
				return { job: result.job, replayed: result.replayed };
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
