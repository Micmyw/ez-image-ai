"use client";

import { ArrowUpRightIcon, CheckIcon, MousePointerClickIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useState } from "react";

import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../lib/prompt-selection";

const SHOWCASE_ITEMS = [
	{
		key: "mediterranean",
		image: "/examples/case-mediterranean-room.webp",
		aspect: "aspect-[4/3]",
	},
	{ key: "cobalt", image: "/examples/case-cobalt-product.webp", aspect: "aspect-[4/5]" },
	{ key: "emerald", image: "/examples/case-emerald-fashion.webp", aspect: "aspect-[4/5]" },
	{ key: "blueHour", image: "/examples/case-blue-hour.webp", aspect: "aspect-[3/2]" },
	{ key: "citrus", image: "/examples/case-citrus-editorial.webp", aspect: "aspect-[4/5]" },
	{ key: "paperTrain", image: "/examples/case-paper-train.webp", aspect: "aspect-[4/5]" },
] as const;

export function ShowcaseSection() {
	const t = useTranslations("home.showcase");
	const [selectedKey, setSelectedKey] = useState<(typeof SHOWCASE_ITEMS)[number]["key"]>();

	function usePrompt(key: (typeof SHOWCASE_ITEMS)[number]["key"]) {
		const prompt = t(`items.${key}.prompt`);
		setSelectedKey(key);
		window.dispatchEvent(
			new CustomEvent<LandingPromptSelectedDetail>(LANDING_PROMPT_SELECTED_EVENT, {
				detail: { prompt },
			}),
		);
	}

	return (
		<section
			id="examples"
			aria-labelledby="examples-title"
			className="scroll-mt-20 py-14 text-white sm:py-20 relative overflow-hidden border-y border-[#2c2440] bg-[#171321]"
		>
			<div
				className="-top-40 -right-32 bg-violet-600/25 blur-3xl pointer-events-none absolute size-[32rem] rounded-full"
				aria-hidden="true"
			/>
			<div
				className="-bottom-52 -left-40 bg-orange-500/15 blur-3xl pointer-events-none absolute size-[32rem] rounded-full"
				aria-hidden="true"
			/>
			<div className="relative container">
				<div className="gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.55fr)] lg:text-left grid items-end text-center">
					<div>
						<p className="gap-2 text-xs font-bold text-violet-300 inline-flex items-center tracking-[0.16em] uppercase">
							<SparklesIcon className="size-3.5" aria-hidden="true" />
							{t("eyebrow")}
						</p>
						<h2
							id="examples-title"
							className="mt-3 max-w-4xl text-3xl font-semibold sm:text-4xl lg:text-5xl leading-[1.02] tracking-[-0.045em] text-balance"
						>
							{t("title")}
						</h2>
					</div>
					<div className="lg:justify-self-end">
						<p className="max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
							{t("description")}
						</p>
						<p className="mt-4 gap-2 text-sm font-semibold text-orange-200 inline-flex items-center">
							<MousePointerClickIcon className="size-4" aria-hidden="true" />
							{t("instruction")}
						</p>
					</div>
				</div>

				<div className="mt-10 gap-4 sm:columns-2 lg:columns-3 columns-1">
					{SHOWCASE_ITEMS.map((item) => (
						<article
							key={item.key}
							className="group mb-4 border-white/10 bg-white/5 shadow-2xl shadow-black/20 break-inside-avoid overflow-hidden rounded-[1.75rem] border"
						>
							<button
								type="button"
								aria-label={t("usePromptLabel", { title: t(`items.${item.key}.title`) })}
								className="focus-visible:outline-orange-300 relative block w-full overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-4"
								onClick={() => usePrompt(item.key)}
							>
								<div className={`bg-slate-800 relative overflow-hidden ${item.aspect}`}>
									<Image
										src={item.image}
										alt={t(`items.${item.key}.alt`)}
										fill
										className="object-cover transition duration-700 group-hover:scale-[1.035] group-focus-visible:scale-[1.035] motion-reduce:transition-none"
										sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
									/>
									<div
										className="inset-0 from-black via-black/10 absolute bg-gradient-to-t to-transparent"
										aria-hidden="true"
									/>
									<span className="top-4 left-4 border-white/25 bg-black/30 px-2.5 py-1 font-bold text-white backdrop-blur-md absolute rounded-full border text-[0.65rem] tracking-[0.12em] uppercase">
										{t(`items.${item.key}.tag`)}
									</span>
									<div className="right-0 bottom-0 left-0 p-5 sm:p-6 absolute">
										<h3 className="text-xl font-bold text-white tracking-[-0.025em]">
											{t(`items.${item.key}.title`)}
										</h3>
										<p className="mt-2 text-sm leading-5 text-white/75 line-clamp-2">
											{t(`items.${item.key}.prompt`)}
										</p>
										<span className="mt-4 gap-2 text-sm font-bold text-white inline-flex items-center">
											{selectedKey === item.key ? (
												<CheckIcon className="size-4 text-emerald-300" aria-hidden="true" />
											) : (
												<ArrowUpRightIcon
													className="size-4 text-orange-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform motion-reduce:transform-none"
													aria-hidden="true"
												/>
											)}
											{selectedKey === item.key ? t("promptAdded") : t("usePrompt")}
										</span>
									</div>
								</div>
							</button>
						</article>
					))}
				</div>
				<p className="mt-6 max-w-3xl text-xs leading-5 text-slate-400">{t("provenanceNote")}</p>
			</div>
		</section>
	);
}
