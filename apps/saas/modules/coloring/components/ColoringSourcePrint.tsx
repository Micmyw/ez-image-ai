"use client";

import { ImagePrintButton } from "@media/components/ImagePrintButton";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";

export function ColoringSourcePrint({ assetId }: { assetId: string }) {
	const t = useTranslations("coloring.handoff");
	return (
		<div className="mt-4 space-y-2" data-test="coloring-source-print">
			<p className="text-sm">{t("printSelected")}</p>
			<ImagePrintButton
				getImageUrl={async () =>
					(await orpcClient.media.getAssetAccessUrl({ assetId, disposition: "inline" })).url
				}
			/>
		</div>
	);
}
