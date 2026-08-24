"use client";

import { ArrowLeftRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useState } from "react";

export function BeforeAfterDemo() {
	const t = useTranslations("home.beforeAfter");
	const [position, setPosition] = useState(52);

	return (
		<section id="before-after" aria-labelledby="before-after-title" className="py-14 sm:py-20">
			<div className="container">
				<div className="gap-8 lg:grid-cols-[0.7fr_1.3fr] lg:gap-14 grid items-center">
					<div>
						<p className="text-xs font-bold text-indigo-700 tracking-[0.16em] uppercase">
							{t("eyebrow")}
						</p>
						<h2
							id="before-after-title"
							className="mt-3 text-3xl leading-tight font-semibold text-slate-950 sm:text-4xl tracking-[-0.035em]"
						>
							{t("title")}
						</h2>
						<p className="mt-4 text-base leading-7 text-slate-600">{t("description")}</p>
						<p className="mt-4 text-sm leading-6 text-slate-500">{t("disclaimer")}</p>
						<div className="mt-6 gap-2 flex flex-wrap">
							<button
								type="button"
								onClick={() => setPosition(0)}
								className="border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-indigo-600 rounded-full border focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								{t("showOriginal")}
							</button>
							<button
								type="button"
								onClick={() => setPosition(100)}
								className="bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-indigo-600 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								{t("showEdit")}
							</button>
						</div>
					</div>

					<div className="bg-slate-950 p-2 shadow-2xl shadow-slate-950/15 sm:p-3 relative overflow-hidden rounded-[2rem]">
						<div className="relative aspect-[3/2] overflow-hidden rounded-[1.55rem]">
							<Image
								src="/examples/studio-before.svg"
								alt={t("beforeAlt")}
								fill
								priority
								className="object-cover"
								sizes="(min-width: 1024px) 58vw, 100vw"
							/>
							<div
								className="inset-0 absolute overflow-hidden"
								style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
								aria-hidden="true"
							>
								<Image
									src="/examples/studio-after.svg"
									alt=""
									fill
									priority
									className="object-cover"
									sizes="(min-width: 1024px) 58vw, 100vw"
								/>
							</div>

							<div
								className="inset-y-0 w-0.5 bg-white pointer-events-none absolute shadow-[0_0_0_1px_rgba(15,23,42,.2)]"
								style={{ left: `${position}%` }}
								aria-hidden="true"
							>
								<span className="size-10 bg-white text-slate-950 shadow-lg absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full">
									<ArrowLeftRightIcon className="size-4" />
								</span>
							</div>

							<span className="top-4 left-4 bg-slate-950/75 px-3 py-1 text-xs font-bold text-white backdrop-blur absolute rounded-full">
								{t("before")}
							</span>
							<span className="top-4 right-4 bg-white/90 px-3 py-1 text-xs font-bold text-slate-950 backdrop-blur absolute rounded-full">
								{t("after")}
							</span>
							<label htmlFor="before-after-control" className="sr-only">
								{t("controlLabel")}
							</label>
							<input
								id="before-after-control"
								type="range"
								min="0"
								max="100"
								value={position}
								onChange={(event) => setPosition(Number(event.target.value))}
								className="inset-0 absolute h-full w-full cursor-ew-resize opacity-0"
							/>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
