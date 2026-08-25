"use client";

import {
	BrushCleaningIcon,
	ImageIcon,
	LayersIcon,
	PaletteIcon,
	SparklesIcon,
	SunMediumIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

const EDITS = [
	{ key: "background", icon: ImageIcon },
	{ key: "objects", icon: LayersIcon },
	{ key: "color", icon: PaletteIcon },
	{ key: "lighting", icon: SunMediumIcon },
	{ key: "style", icon: SparklesIcon },
	{ key: "cleanup", icon: BrushCleaningIcon },
] as const;

export function SupportedEditsSection() {
	const t = useTranslations("home");

	return (
		<section
			id="supported-edits"
			aria-labelledby="supported-edits-title"
			className="py-14 sm:py-20"
		>
			<div className="container">
				<div className="max-w-3xl mx-auto text-center">
					<p className="text-xs font-bold text-indigo-700 tracking-[0.16em] uppercase">
						{t("supportedEdits.eyebrow")}
					</p>
					<h2
						id="supported-edits-title"
						className="mt-3 text-3xl font-semibold text-slate-950 sm:text-4xl tracking-[-0.035em]"
					>
						{t("supportedEdits.title")}
					</h2>
					<p className="mt-4 text-base leading-7 text-slate-600">
						{t("supportedEdits.description")}
					</p>
				</div>
				<div className="mt-10 gap-4 sm:grid-cols-2 lg:grid-cols-3 grid">
					{EDITS.map(({ key, icon: Icon }) => (
						<article key={key} className="border-slate-200 bg-white p-6 rounded-3xl border">
							<Icon className="size-5 text-indigo-700" aria-hidden="true" />
							<h3 className="mt-4 text-lg font-bold text-slate-950">
								{t(`supportedEdits.items.${key}.title`)}
							</h3>
							<p className="mt-2 text-sm leading-6 text-slate-600">
								{t(`supportedEdits.items.${key}.description`)}
							</p>
						</article>
					))}
				</div>
			</div>
		</section>
	);
}
