"use client";

import { Button } from "@repo/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";

import { useAssets } from "../hooks/use-assets";
import { AssetCard } from "./AssetCard";

export function AssetLibrary() {
	const t = useTranslations("media.assets");
	const router = useRouter();
	const searchParams = useSearchParams();
	const kind = searchParams.get("kind") as "image" | "video" | null;
	const assets = useAssets(kind ?? undefined);
	const items = assets.data?.pages.flatMap((page) => page.items) ?? [];
	function setKind(value: string) {
		const next = new URLSearchParams(searchParams);
		if (value === "all") next.delete("kind");
		else next.set("kind", value);
		router.replace(`/assets?${next}`);
	}
	return (
		<div>
			<div className="mb-6 gap-4 sm:flex-row sm:items-end flex flex-col justify-between">
				<div>
					<h1 className="text-3xl font-medium">{t("title")}</h1>
					<p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
				</div>
				<Select
					value={kind ?? "all"}
					onValueChange={(value) => {
						if (value) setKind(value);
					}}
				>
					<SelectTrigger className="sm:w-48 w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{["all", "image", "video"].map((value) => (
							<SelectItem key={value} value={value}>
								{t(`filters.${value}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
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
