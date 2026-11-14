"use client";

import {
	generationDurationInputSchema,
	isFreshGenerationDurationEstimate,
} from "@repo/database/generation-duration-contract";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";

export interface GenerationDurationEstimateProps {
	productKey: string;
	skuKey: string;
	serviceClass?: "STANDARD" | "GUEST_SLOW";
	active?: boolean;
	className?: string;
}

export function GenerationDurationEstimate({
	productKey,
	skuKey,
	serviceClass = "STANDARD",
	active = true,
	className,
}: GenerationDurationEstimateProps) {
	const t = useTranslations("media.durationEstimate");
	const format = useFormatter();
	const selection = generationDurationInputSchema.safeParse({ productKey, skuKey, serviceClass });
	const result = useQuery(
		orpc.media.getGenerationDuration.queryOptions({
			input: selection.success
				? selection.data
				: {
						productKey: "image-nano-banana-2-lite",
						skuKey: "nano-banana-2-lite-1k",
						serviceClass,
					},
			enabled: active && selection.success,
			staleTime: 120_000,
			refetchInterval: active && selection.success ? 120_000 : false,
			refetchOnWindowFocus: false,
			retry: false,
		}),
	);
	if (!active) return null;
	const observation =
		!result.isError &&
		selection.success &&
		result.data &&
		isFreshGenerationDurationEstimate(result.data)
			? result.data
			: null;
	return (
		<div className={className} data-testid="generation-duration-estimate" aria-live="polite">
			<p className="text-sm text-muted-foreground">
				{observation
					? t("range", { minimum: observation.minimumSeconds, maximum: observation.maximumSeconds })
					: t("processing")}
			</p>
			{observation && (
				<p className="mt-1 text-xs text-muted-foreground">
					{t("basis", {
						count: observation.sampleSize,
						asOf: format.dateTime(new Date(observation.asOf), {
							month: "short",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
						}),
					})}
				</p>
			)}
		</div>
	);
}
