"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";

const SHOWCASE_ITEMS = [
	{ key: "background", image: "/examples/edit-background.svg" },
	{ key: "object", image: "/examples/edit-object.svg" },
	{ key: "color", image: "/examples/edit-color.svg" },
	{ key: "lighting", image: "/examples/edit-lighting.svg" },
	{ key: "style", image: "/examples/edit-style.svg" },
] as const;

export function ShowcaseSection() {
	const t = useTranslations("home.showcase");

	return (
		<section
			id="examples"
			aria-labelledby="examples-title"
			className="scroll-mt-24 border-slate-200 bg-slate-50 py-14 sm:py-20 border-y"
		>
			<div className="container">
				<div className="max-w-3xl mx-auto text-center">
					<p className="text-xs font-bold text-indigo-700 tracking-[0.16em] uppercase">
						{t("eyebrow")}
					</p>
					<h2
						id="examples-title"
						className="mt-3 text-3xl font-semibold text-slate-950 sm:text-4xl lg:text-5xl tracking-[-0.035em] text-balance"
					>
						{t("title")}
					</h2>
					<p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">{t("description")}</p>
				</div>

				<div className="mt-10 gap-4 sm:grid-cols-2 lg:grid-cols-6 grid">
					{SHOWCASE_ITEMS.map((item, index) => (
						<article
							key={item.key}
							className={`group border-slate-200 bg-white shadow-sm overflow-hidden rounded-[1.75rem] border ${
								index < 2 ? "lg:col-span-3" : "lg:col-span-2"
							}`}
						>
							<div className="bg-slate-200 relative aspect-[8/5] overflow-hidden">
								<Image
									src={item.image}
									alt={t(`items.${item.key}.alt`)}
									fill
									className="object-cover transition duration-500 group-hover:scale-[1.02] motion-reduce:transition-none"
									sizes={
										index < 2
											? "(min-width: 1024px) 50vw, 100vw"
											: "(min-width: 1024px) 33vw, 100vw"
									}
								/>
								<span className="top-3 left-3 bg-white/90 px-2.5 py-1 font-bold text-slate-800 backdrop-blur absolute rounded-full text-[0.65rem] tracking-[0.12em] uppercase">
									{t(`items.${item.key}.tag`)}
								</span>
							</div>
							<div className="p-5">
								<h3 className="text-lg font-bold text-slate-950 tracking-[-0.02em]">
									{t(`items.${item.key}.title`)}
								</h3>
								<p className="mt-2 text-sm leading-6 text-slate-600">
									{t(`items.${item.key}.description`)}
								</p>
							</div>
						</article>
					))}
				</div>
				<p className="mt-5 text-xs leading-5 text-slate-500 text-center">{t("provenanceNote")}</p>
			</div>
		</section>
	);
}
