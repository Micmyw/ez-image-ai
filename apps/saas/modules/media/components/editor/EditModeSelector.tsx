import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";

import type { EditorProductKey } from "../../lib/editor-recovery";

interface ModeProduct {
	key: string;
	credits: number;
}

export function EditModeSelector({
	value,
	onChange,
	onUpgrade,
	products,
	allowedProductKeys,
}: {
	value: EditorProductKey;
	onChange: (value: EditorProductKey) => void;
	onUpgrade: () => void;
	products: ModeProduct[];
	allowedProductKeys: EditorProductKey[];
}) {
	const t = useTranslations("media.editor.mode");
	const modes = (["image-fast", "image-quality"] as const).flatMap((key) => {
		const product = products.find((candidate) => candidate.key === key);
		return product ? [{ key, credits: product.credits }] : [];
	});

	return (
		<fieldset className="space-y-3">
			<legend className="font-medium text-sm">{t("label")}</legend>
			<div className="gap-3 sm:grid-cols-2 grid" role="radiogroup" aria-label={t("label")}>
				{modes.map((mode) => {
					const quality = mode.key === "image-quality";
					const allowed = allowedProductKeys.includes(mode.key);
					return (
						<label
							key={mode.key}
							className={`p-4 rounded-xl border transition ${
								value === mode.key ? "border-primary bg-primary/5" : "bg-background"
							} cursor-pointer hover:border-primary/50 ${allowed ? "" : "border-dashed"}`}
						>
							<span className="gap-3 flex items-start">
								<input
									type="radio"
									name="editor-mode"
									value={mode.key}
									checked={value === mode.key}
									aria-label={quality ? t("quality") : t("standard")}
									onChange={() => onChange(mode.key)}
									className="mt-1"
								/>
								<span className="min-w-0 flex-1">
									<span className="gap-3 flex items-center justify-between">
										<strong>{quality ? t("quality") : t("standard")}</strong>
										<span className="text-xs text-muted-foreground">
											{t("credits", { credits: mode.credits })}
										</span>
									</span>
									<span className="mt-1 text-xs block text-muted-foreground">
										{quality ? t("qualityDescription") : t("standardDescription")}
									</span>
								</span>
							</span>
						</label>
					);
				})}
			</div>
			{!allowedProductKeys.includes("image-quality") && (
				<div className="gap-3 p-3 flex flex-wrap items-center justify-between rounded-xl border bg-muted/40">
					<p className="text-sm text-muted-foreground">{t("qualityUnavailable")}</p>
					<Button type="button" size="sm" variant="secondary" onClick={onUpgrade}>
						{t("upgrade")}
					</Button>
				</div>
			)}
		</fieldset>
	);
}
