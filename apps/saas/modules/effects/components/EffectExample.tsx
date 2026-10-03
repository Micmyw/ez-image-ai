"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";
import { useId, useState } from "react";

import type { PublicEffectExample } from "../lib/types";

import "../effects.css";

export function EffectExample({
	example,
	compact = false,
}: {
	example: PublicEffectExample;
	compact?: boolean;
}) {
	const t = useTranslations("effects");
	const model = useTranslations("media.create.products");
	const sku = useTranslations("media.create.skus");
	const parameter = useTranslations("media.create.outputSettings.optionLabels");
	const [side, setSide] = useState<"input" | "output">("output");
	const id = useId();
	return (
		<figure
			className={`effect-example${compact ? " is-compact" : ""}`}
			data-example-id={example.id}
		>
			<div className="effect-example-top">
				<span>{t("example")}</span>
				<fieldset className="effect-example-switch" aria-label={t("compare")}>
					{(["input", "output"] as const).map((value) => (
						<button
							type="button"
							key={value}
							aria-pressed={side === value}
							aria-controls={id}
							onClick={() => setSide(value)}
						>
							{t(value === "input" ? "before" : "generatedLabel")}
						</button>
					))}
				</fieldset>
			</div>
			<div id={id} className="effect-example-media">
				{(["input", "output"] as const).map((value) => {
					const asset = example[value];
					return (
						<div key={value} className="effect-example-frame" hidden={side !== value}>
							<Image
								src={asset.src}
								alt={asset.alt}
								width={asset.width}
								height={asset.height}
								sizes={
									compact
										? "(max-width: 600px) 100vw, (max-width: 1100px) 50vw, 33vw"
										: "(max-width: 767px) 100vw, 45vw"
								}
							/>
							<span className="effect-example-label">
								{t(value === "input" ? "before" : "generatedLabel")}
							</span>
						</div>
					);
				})}
			</div>
			<figcaption>
				<p>{example.caption}</p>
				<p className="effect-test-caption">
					<time dateTime={example.testedAt}>
						{t("tested", { date: example.testedAt, version: example.presetVersion })}
					</time>
				</p>
				<p className="effect-test-caption">
					{model(`${example.productKey}.label`)} · {sku(`${example.parameters.skuKey}.label`)} ·{" "}
					{example.parameters.aspectRatio}
					{example.parameters.outputFormat && <> · {parameter(example.parameters.outputFormat)}</>}
					{example.parameters.background && <> · {parameter(example.parameters.background)}</>}
				</p>
			</figcaption>
		</figure>
	);
}
