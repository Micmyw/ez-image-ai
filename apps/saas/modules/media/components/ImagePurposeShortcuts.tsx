"use client";

import type { ImageOutputFormat, ImageSkuKey } from "@repo/config/client";
import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

import type { EditorProductKey } from "../lib/editor-recovery";
import { getImagePurposeShortcuts, type ImagePurposeProduct } from "../lib/image-purpose-shortcuts";

export function ImagePurposeShortcuts({
	products,
	value,
	skuKey,
	outputFormat,
	frameCount,
	onSelect,
	disabled = false,
}: {
	products: readonly ImagePurposeProduct[];
	value: string | null;
	skuKey: string | null;
	outputFormat?: ImageOutputFormat;
	frameCount?: number;
	onSelect: (productKey: EditorProductKey, skuKey: ImageSkuKey) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("media.purposeShortcuts");
	const choices = getImagePurposeShortcuts(products, { outputFormat, frameCount });
	if (!choices.length) return null;
	return (
		<fieldset className="mb-3 space-y-2" disabled={disabled}>
			<legend className="text-xs text-muted-foreground">{t("label")}</legend>
			<div className="gap-2 flex flex-wrap" data-test="image-purpose-shortcuts">
				{choices.map((choice) => (
					<Button
						key={choice.key}
						type="button"
						variant="secondary"
						size="sm"
						className="gap-0.5 py-2 h-auto flex-col items-start"
						aria-pressed={value === choice.productKey && skuKey === choice.skuKey}
						disabled={disabled}
						onClick={() => onSelect(choice.productKey, choice.skuKey)}
					>
						<span>{t(choice.key)}</span>
						<span className="font-normal text-[11px] text-muted-foreground">
							{t("selection", { model: choice.modelLabel, credits: choice.credits })}
						</span>
					</Button>
				))}
			</div>
		</fieldset>
	);
}
