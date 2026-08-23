"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { GenerationInput } from "../lib/form-schema";

export function useGeneration() {
	const queryClient = useQueryClient();
	const actionKey = useRef<string | null>(null);
	const [quote, setQuote] = useState<{ id: string; credits: string; expiresAt: string } | null>(
		null,
	);
	const catalog = useQuery({
		queryKey: ["media-catalog"],
		queryFn: () => orpcClient.media.getPublicCatalog(),
		staleTime: 5 * 60_000,
	});
	const createQuote = useMutation({
		mutationFn: (input: {
			productKey: "image-fast" | "image-quality" | "video-fast" | "video-quality";
			input: GenerationInput;
		}) => orpcClient.media.createQuote(input),
		onSuccess: (value) => setQuote(value),
	});
	const createGeneration = useMutation({
		mutationFn: async () => {
			if (!quote) throw new Error("QUOTE_REQUIRED");
			actionKey.current ??= crypto.randomUUID();
			return orpcClient.media.createGeneration({
				quoteId: quote.id,
				idempotencyKey: actionKey.current,
			});
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["media-jobs"] });
		},
	});
	function beginNewAction() {
		actionKey.current = null;
		setQuote(null);
		createQuote.reset();
		createGeneration.reset();
	}
	return { catalog, quote, createQuote, createGeneration, beginNewAction };
}
