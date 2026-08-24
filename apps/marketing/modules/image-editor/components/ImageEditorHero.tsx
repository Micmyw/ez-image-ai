"use client";

import { CheckCircle2Icon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { MarketingGenerator } from "../../generator/components/MarketingGenerator";
import type { MarketingImageModes } from "../../generator/lib/marketing-catalog";

export function ImageEditorHero({ modes }: { modes: MarketingImageModes }) {
	const t = useTranslations("home.imageEditorHero");

	return (
		<section
			id="image-editor"
			aria-labelledby="image-editor-title"
			className="border-indigo-100 py-10 sm:py-14 lg:py-20 relative overflow-hidden border-b bg-[linear-gradient(180deg,#f7f8ff_0%,#ffffff_78%)]"
		>
			<div
				className="-top-40 h-80 bg-indigo-300/20 blur-3xl pointer-events-none absolute left-1/2 w-[52rem] -translate-x-1/2 rounded-full"
				aria-hidden="true"
			/>
			<div className="relative container">
				<div className="max-w-5xl mx-auto text-center">
					<div className="gap-2 border-indigo-200 bg-white/80 px-3 py-1.5 text-xs font-bold text-indigo-800 shadow-sm backdrop-blur inline-flex items-center rounded-full border tracking-[0.1em] uppercase">
						<SparklesIcon className="size-3.5" aria-hidden="true" />
						{t("eyebrow")}
					</div>
					<h1
						id="image-editor-title"
						className="mt-5 max-w-5xl text-4xl font-semibold text-slate-950 sm:text-5xl lg:text-7xl mx-auto leading-[1.02] tracking-[-0.045em] text-balance"
					>
						{t("title")}
					</h1>
					<p className="mt-5 max-w-3xl text-base leading-7 text-slate-600 sm:text-lg mx-auto text-balance">
						{t("subtitle")}
					</p>
					<div className="mt-5 gap-x-5 gap-y-2 text-sm font-medium text-slate-600 flex flex-wrap items-center justify-center">
						<span className="gap-1.5 inline-flex items-center">
							<ShieldCheckIcon className="size-4 text-emerald-600" aria-hidden="true" />
							{t("private")}
						</span>
						<span className="gap-1.5 inline-flex items-center">
							<CheckCircle2Icon className="size-4 text-indigo-600" aria-hidden="true" />
							{t("draftOnly")}
						</span>
					</div>
				</div>

				<MarketingGenerator modes={modes} />
			</div>
		</section>
	);
}
