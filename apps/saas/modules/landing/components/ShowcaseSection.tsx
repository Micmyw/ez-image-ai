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
		width: 1200,
		height: 900,
	},
	{
		key: "lunarGreenhouse",
		image: "/examples/case-lunar-greenhouse.webp",
		width: 864,
		height: 1080,
	},
	{ key: "cobalt", image: "/examples/case-cobalt-product.webp", width: 1024, height: 1536 },
	{ key: "origamiKoi", image: "/examples/case-origami-koi.webp", width: 1200, height: 800 },
	{ key: "emerald", image: "/examples/case-emerald-fashion.webp", width: 1024, height: 1536 },
	{
		key: "tangerineCamera",
		image: "/examples/case-tangerine-camera.webp",
		width: 960,
		height: 960,
	},
	{ key: "blueHour", image: "/examples/case-blue-hour.webp", width: 1200, height: 800 },
	{
		key: "porcelainTide",
		image: "/examples/case-porcelain-tide.webp",
		width: 960,
		height: 1200,
	},
	{ key: "citrus", image: "/examples/case-citrus-editorial.webp", width: 1024, height: 1536 },
	{ key: "velvetFox", image: "/examples/case-velvet-fox.webp", width: 960, height: 1200 },
	{ key: "paperTrain", image: "/examples/case-paper-train.webp", width: 900, height: 1350 },
	{ key: "desertPool", image: "/examples/case-desert-pool.webp", width: 1200, height: 800 },
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
			className="scroll-mt-20 py-14 text-white sm:py-20 relative overflow-hidden bg-transparent"
		>
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

				<div className="mt-10 gap-3 sm:gap-4 md:columns-3 lg:gap-5 xl:columns-4 columns-2">
					{SHOWCASE_ITEMS.map((item) => (
						<article
							key={item.key}
							className={`group mb-3 sm:mb-4 lg:mb-5 bg-white/[0.035] hover:border-violet-300/70 focus-within:border-violet-300/80 focus-within:ring-violet-300/90 motion-safe:hover:-translate-y-1 motion-safe:focus-within:-translate-y-1 relative w-full break-inside-avoid overflow-hidden rounded-[1.35rem] border shadow-[0_18px_50px_-28px_rgba(0,0,0,0.85)] focus-within:z-10 focus-within:shadow-[0_30px_80px_-22px_rgba(124,58,237,0.72)] focus-within:ring-2 focus-within:ring-offset-4 focus-within:ring-offset-[#16101f] hover:z-10 hover:shadow-[0_30px_80px_-22px_rgba(124,58,237,0.72)] motion-safe:transition-[transform,translate,scale,box-shadow,border-color] motion-safe:duration-[1200ms] motion-safe:ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-safe:focus-within:scale-[1.05] motion-safe:hover:scale-[1.05] ${
								selectedKey === item.key
									? "border-violet-300/90 ring-violet-300/60 ring-1"
									: "border-white/10"
							}`}
						>
							<button
								type="button"
								aria-label={t("usePromptLabel", { title: t(`items.${item.key}.title`) })}
								aria-pressed={selectedKey === item.key}
								className="@container relative block w-full overflow-hidden text-left focus-visible:outline-none"
								onClick={() => usePrompt(item.key)}
							>
								<div className="bg-slate-800 relative overflow-hidden">
									<Image
										src={item.image}
										alt={t(`items.${item.key}.alt`)}
										width={item.width}
										height={item.height}
										className="block h-auto w-full"
										sizes="(min-width: 1280px) 300px, (min-width: 768px) 33vw, 50vw"
									/>
									<div className="gap-3 p-3 @[16rem]:p-4 motion-safe:ease-out [@media(hover:hover)_and_(min-width:768px)]:inset-0 pointer-events-none relative flex flex-col opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-safe:transition-opacity motion-safe:duration-300 [@media(hover:hover)_and_(min-width:768px)]:absolute [@media(hover:hover)_and_(min-width:768px)]:justify-between [@media(hover:hover)_and_(min-width:768px)]:opacity-0">
										<div
											className="inset-0 absolute bg-gradient-to-t from-[#120d1c]/95 via-[#120d1c]/25 to-transparent"
											aria-hidden="true"
										/>
										<span className="border-white/25 bg-black/35 px-2.5 py-1 font-bold text-white backdrop-blur-md relative self-start rounded-full border text-[0.65rem] tracking-[0.12em] uppercase">
											{t(`items.${item.key}.tag`)}
										</span>
										<span className="inset-3 absolute opacity-80" aria-hidden="true">
											<span className="top-0 left-0 size-4 border-violet-200 absolute border-t border-l" />
											<span className="right-0 bottom-0 size-4 border-violet-200 absolute border-r border-b" />
										</span>
										<div className="relative">
											<h3 className="text-sm @[16rem]:text-base font-bold text-white tracking-[-0.025em]">
												{t(`items.${item.key}.title`)}
											</h3>
											<p className="mt-2 text-sm leading-5 text-white/80 hidden @[16rem]:line-clamp-2">
												{t(`items.${item.key}.prompt`)}
											</p>
											<span className="mt-2 gap-2 text-xs @[16rem]:text-sm font-bold text-white inline-flex items-center">
												{selectedKey === item.key ? (
													<CheckIcon className="size-4 text-emerald-300" aria-hidden="true" />
												) : (
													<ArrowUpRightIcon
														className="size-4 text-violet-200 motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5 motion-safe:transition-transform"
														aria-hidden="true"
													/>
												)}
												{selectedKey === item.key ? t("promptAdded") : t("usePrompt")}
											</span>
										</div>
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
