"use client";

import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

import { useAssets } from "../hooks/use-assets";
import { AssetCard } from "./AssetCard";

export function AssetLibrary() {
	const t = useTranslations("media.assets");
	const assets = useAssets("image");
	const items = assets.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<div>
			<div className="mb-6">
				<div>
					<h1 className="text-3xl font-medium">{t("title")}</h1>
					<p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
				</div>
			</div>
			<div className="gap-4 sm:grid-cols-2 xl:grid-cols-3 grid">
				{items.map((asset) => (
					<AssetCard key={asset.id} asset={asset} onDeleted={() => assets.refetch()} />
				))}
			</div>
			{!items.length && !assets.isLoading && (
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
