"use client";

import {
	IMAGE_ASPECT_RATIOS,
	LEGACY_EZPIC_PRODUCT_KEYS,
	type ImageAspectRatio,
} from "@repo/config/client";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { useJobHistory } from "../hooks/use-job-history";
import { isEditorProductKey, type EditorProductKey } from "../lib/editor-recovery";
import { isPublicImageSkuKey } from "../lib/image-sku-selection";
import { getJobPresentation } from "../lib/job-status";

export function JobHistory() {
	const t = useTranslations("media.history");
	const stages = useTranslations("media.status.stages");
	const products = useTranslations("media.create.products");
	const skus = useTranslations("media.create.skus");
	const outputSettings = useTranslations("media.create.outputSettings");
	const router = useRouter();
	const searchParams = useSearchParams();
	const status = searchParams.get("status") as
		| "active"
		| "succeeded"
		| "failed"
		| "canceled"
		| null;
	const history = useJobHistory({ status: status ?? undefined });
	const jobs = history.data?.pages.flatMap((page) => page.items).filter(hasImageHistoryKey) ?? [];

	function setStatus(value: string) {
		const next = new URLSearchParams(searchParams);
		if (value === "all") next.delete("status");
		else next.set("status", value);
		router.replace(next.size ? `/history?${next}` : "/history");
	}

	return (
		<div>
			<div className="mb-6 gap-4 sm:flex-row sm:items-end flex flex-col justify-between">
				<div>
					<h1 className="text-3xl font-medium">{t("title")}</h1>
					<p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
				</div>
				<Select
					value={status ?? "all"}
					onValueChange={(value) => {
						if (value) setStatus(value);
					}}
				>
					<SelectTrigger className="sm:w-48 w-full" aria-label={t("filter")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{["all", "active", "succeeded", "failed", "canceled"].map((value) => (
							<SelectItem key={value} value={value}>
								{t(`filters.${value}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="divide-y rounded-2xl border bg-background">
				{jobs.map((job) => {
					const stage = getJobPresentation({ status: job.status }).stage;
					const currentProductKey = isEditorProductKey(job.productKey) ? job.productKey : null;
					const skuKey =
						currentProductKey && job.skuKey && isPublicImageSkuKey(job.skuKey) ? job.skuKey : null;
					const aspectRatio =
						currentProductKey && isImageAspectRatio(job.aspectRatio) ? job.aspectRatio : null;
					return (
						<Link
							key={job.id}
							href={`/history/${job.id}`}
							className="gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center grid transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
						>
							<div>
								<div className="gap-2 flex items-center">
									<span className="font-medium">
										{currentProductKey
											? products(`${currentProductKey}.label`)
											: t("legacyProduct")}
									</span>
									<Badge status="info">{stages(stage)}</Badge>
								</div>
								{skuKey && aspectRatio && (
									<p className="mt-1 text-sm text-muted-foreground">
										{skus(`${skuKey}.label`)} ·{" "}
										{aspectRatio === "auto" ? outputSettings("automatic") : aspectRatio}
									</p>
								)}
								<p className="mt-1 text-xs text-muted-foreground">
									{new Date(job.createdAt).toLocaleString()} ·{" "}
									{t("outputs", { count: job.outputCount })}
								</p>
							</div>
							<div className="text-sm">
								<span className="text-muted-foreground">{t("reserved")}</span>{" "}
								<strong>{job.creditsReserved}</strong>
							</div>
							<span aria-hidden>→</span>
						</Link>
					);
				})}
				{!jobs.length && !history.isLoading && (
					<p className="p-8 text-center text-muted-foreground">{t("empty")}</p>
				)}
			</div>
			{history.hasNextPage && (
				<Button
					className="mt-5"
					variant="secondary"
					loading={history.isFetchingNextPage}
					onClick={() => history.fetchNextPage()}
				>
					{t("more")}
				</Button>
			)}
		</div>
	);
}

type HistoryImageProductKey = EditorProductKey | (typeof LEGACY_EZPIC_PRODUCT_KEYS)[number];

function hasImageHistoryKey<T extends { productKey: string }>(
	job: T,
): job is T & { productKey: HistoryImageProductKey } {
	return (
		isEditorProductKey(job.productKey) ||
		LEGACY_EZPIC_PRODUCT_KEYS.includes(job.productKey as (typeof LEGACY_EZPIC_PRODUCT_KEYS)[number])
	);
}

function isImageAspectRatio(value: string | null | undefined): value is ImageAspectRatio {
	return Boolean(value && IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio));
}
