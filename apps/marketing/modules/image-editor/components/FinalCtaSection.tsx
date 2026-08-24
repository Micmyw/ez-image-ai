"use client";

import { ArrowUpIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function FinalCtaSection() {
	const t = useTranslations("home.finalCta");

	return (
		<section id="final-cta" aria-labelledby="final-cta-title" className="px-4 py-14 sm:py-20">
			<div className="bg-indigo-600 px-6 py-12 text-white shadow-xl shadow-indigo-900/20 sm:px-10 sm:py-16 container overflow-hidden rounded-[2.25rem] text-center">
				<p className="text-xs font-bold text-indigo-100 tracking-[0.16em] uppercase">
					{t("eyebrow")}
				</p>
				<h2
					id="final-cta-title"
					className="mt-4 max-w-3xl text-3xl font-semibold sm:text-5xl mx-auto tracking-[-0.04em] text-balance"
				>
					{t("title")}
				</h2>
				<p className="mt-4 max-w-2xl text-base leading-7 text-indigo-100 mx-auto">
					{t("description")}
				</p>
				<a
					href="#image-editor"
					className="mt-7 h-12 gap-2 bg-white px-6 text-sm font-bold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-white inline-flex items-center justify-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-4"
				>
					{t("button")}
					<ArrowUpIcon className="size-4" aria-hidden="true" />
				</a>
			</div>
		</section>
	);
}
