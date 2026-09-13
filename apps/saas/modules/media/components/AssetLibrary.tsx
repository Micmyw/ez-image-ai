"use client";

import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

import { useAssets } from "../hooks/use-assets";
import { AssetCard } from "./AssetCard";

export function AssetLibrary({
	embedded = false,
	onSelect,
}: { embedded?: boolean; onSelect?: (assetId: string) => void } = {}) {
	const studio = useTranslations("studio");
	const t = useTranslations("media.assets");
	const assets = useAssets("image");
	const items = assets.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<div>
			{assets.isLoading && (
				<output className="mb-4 text-sm block text-muted-foreground">{studio("loading")}</output>
			)}
			{assets.isError && (
				<div role="alert" className="mb-4 p-4 rounded-xl border">
					<p className="text-sm">{studio("error")}</p>
					<Button className="mt-3" variant="secondary" onClick={() => void assets.refetch()}>
						{studio("retry")}
					</Button>
				</div>
			)}
			<div className="mb-6" hidden={embedded}>
				<div>
					<h1 className="text-3xl font-medium">{t("title")}</h1>
					<p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
				</div>
			</div>
			<div className={embedded ? "gap-4 grid" : "gap-4 sm:grid-cols-2 xl:grid-cols-3 grid"}>
				{items.map((asset) => (
					<AssetCard
						key={asset.id}
						asset={asset}
						onDeleted={() => assets.refetch()}
						onSelect={onSelect}
					/>
				))}
			</div>
			{!items.length && !assets.isLoading && !assets.isError && (
				<p className="p-8 rounded-2xl border text-center text-muted-foreground">{t("empty")}</p>
			)}
			{assets.hasNextPage && (
				<Button
					className="mt-5"
					variant="secondary"
					loading={assets.isFetchingNextPage}
					onClick={() => assets.fetchNextPage()}
				>
					{t("more")}
				</Button>
			)}
		</div>
	);
}
