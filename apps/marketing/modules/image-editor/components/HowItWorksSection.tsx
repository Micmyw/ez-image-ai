"use client";

import { FileCheck2Icon, ImageUpIcon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";

const STEPS = [
	{ key: "draft", icon: ImageUpIcon },
	{ key: "signin", icon: FileCheck2Icon },
	{ key: "generate", icon: WandSparklesIcon },
] as const;

export function HowItWorksSection() {
	const t = useTranslations("home.howItWorks");

	return (
		<section
			id="how-it-works"
			aria-labelledby="how-it-works-title"
			className="scroll-mt-24 border-slate-200 bg-slate-50 py-14 sm:py-20 border-y"
		>
			<div className="container">
				<div className="max-w-3xl mx-auto text-center">
					<p className="text-xs font-bold text-indigo-700 tracking-[0.16em] uppercase">
						{t("eyebrow")}
					</p>
					<h2
						id="how-it-works-title"
						className="mt-3 text-3xl font-semibold text-slate-950 sm:text-4xl tracking-[-0.035em]"
					>
						{t("title")}
					</h2>
					<p className="mt-4 text-base leading-7 text-slate-600">{t("description")}</p>
				</div>

				<ol className="mt-10 gap-4 lg:grid-cols-3 relative grid">
					{STEPS.map(({ key, icon: Icon }, index) => (
						<li
							key={key}
							className="border-slate-200 bg-white p-6 shadow-sm sm:p-8 relative rounded-[1.75rem] border"
						>
							<div className="gap-4 flex items-center justify-between">
								<span className="size-11 bg-indigo-50 text-indigo-700 grid place-items-center rounded-2xl">
									<Icon className="size-5" aria-hidden="true" />
								</span>
								<span className="font-mono text-sm font-bold text-slate-300">0{index + 1}</span>
							</div>
							<h3 className="mt-6 text-xl font-bold text-slate-950 tracking-[-0.025em]">
								{t(`steps.${key}.title`)}
							</h3>
							<p className="mt-3 text-sm leading-6 text-slate-600">
								{t(`steps.${key}.description`)}
							</p>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}
