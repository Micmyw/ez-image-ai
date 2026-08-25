"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { createEditorActionController } from "../lib/editor-action";
import type { EditorProductKey } from "../lib/editor-recovery";
import type { GenerationInput } from "../lib/form-schema";

export function useGeneration({ parentJobId }: { parentJobId?: string | null } = {}) {
	const queryClient = useQueryClient();
	const action = useRef<ReturnType<typeof createEditorActionController> | null>(null);
	action.current ??= createEditorActionController();
	const [quote, setQuote] = useState<{
		id: string;
		productKey: "image-fast" | "image-quality";
		credits: string;
		expiresAt: string;
	} | null>(null);
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
			productKey: "image-fast" | "image-quality";
			input: GenerationInput;
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
			if (action.current!.acceptQuote(request)) setQuote(value);
		},
	});
	const createGeneration = useMutation({
		mutationFn: async () => {
			if (!quote) throw new Error("QUOTE_REQUIRED");
			return orpcClient.media.createGeneration({
				quoteId: quote.id,
				idempotencyKey: action.current!.idempotencyKeyFor(quote.id),
				...(parentJobId ? { parentJobId } : {}),
			});
		},
		onSettled: () => refreshGenerationQueries(queryClient),
	});
	function beginNewAction() {
		action.current!.invalidate();
		setQuote(null);
		createQuote.reset();
		createGeneration.reset();
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

function requireEditorProductKey(productKey: string): EditorProductKey {
	if (productKey === "image-fast" || productKey === "image-quality") return productKey;
	throw new Error("PRODUCT_UNAVAILABLE");
}
