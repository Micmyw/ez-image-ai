"use client";

import type { ImageOutputFormat, ImageSkuKey } from "@repo/config/client";
import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

import type { EditorProductKey } from "../lib/editor-recovery";
import { getImagePurposeShortcuts, type ImagePurposeProduct } from "../lib/image-purpose-shortcuts";

import styles from "./ImagePurposeShortcuts.module.css";

export function ImagePurposeShortcuts({
	products,
	value,
	skuKey,
	outputFormat,
	frameCount,
	onSelect,
	disabled = false,
	compactOnNarrow = false,
	pending = false,
}: {
	products: readonly ImagePurposeProduct[];
	value: string | null;
	skuKey: string | null;
	outputFormat?: ImageOutputFormat;
	frameCount?: number;
	onSelect: (productKey: EditorProductKey, skuKey: ImageSkuKey) => void;
	disabled?: boolean;
	compactOnNarrow?: boolean;
	pending?: boolean;
}) {
	const t = useTranslations("media.purposeShortcuts");
	const choices = getImagePurposeShortcuts(products, { outputFormat, frameCount });
	if (!choices.length)
		return compactOnNarrow && pending ? <div className={styles.pending} /> : null;
	return (
		<fieldset
			className={`mb-3 space-y-2 ${compactOnNarrow ? styles.responsive : ""}`}
			disabled={disabled}
		>
			<legend className={`text-xs text-muted-foreground ${styles.legend}`}>{t("label")}</legend>
			<div className={`gap-2 flex flex-wrap ${styles.track}`} data-test="image-purpose-shortcuts">
				{choices.map((choice) => (
					<Button
						key={choice.key}
						type="button"
						variant="secondary"
						size="sm"
						className={`gap-0.5 py-2 h-auto flex-col items-start ${styles.choice}`}
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
