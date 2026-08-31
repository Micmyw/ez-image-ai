"use client";

import { ArrowLeftRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useState } from "react";

export function BeforeAfterDemo() {
	const t = useTranslations("home.beforeAfter");
	const [position, setPosition] = useState(52);

	return (
		<section
			id="before-after"
			aria-labelledby="before-after-title"
			className="py-14 text-white sm:py-20 relative overflow-hidden border-b border-[#2c2440] bg-[#100d1b]"
		>
			<div
				className="-right-48 bg-orange-400/10 blur-3xl pointer-events-none absolute bottom-[-18rem] size-[34rem] rounded-full"
				aria-hidden="true"
			/>
			<div className="container">
				<div className="gap-8 lg:grid-cols-[0.7fr_1.3fr] lg:gap-14 relative grid items-center">
					<div>
						<p className="text-xs font-bold text-violet-300 tracking-[0.16em] uppercase">
							{t("eyebrow")}
						</p>
						<h2
							id="before-after-title"
							className="mt-3 text-3xl leading-tight font-semibold text-white sm:text-4xl tracking-[-0.035em]"
						>
							{t("title")}
						</h2>
						<p className="mt-4 text-base leading-7 text-slate-300">{t("description")}</p>
						<p className="mt-4 text-sm leading-6 text-slate-400">{t("disclaimer")}</p>
						<div className="mt-6 gap-2 flex flex-wrap">
							<button
								type="button"
								onClick={() => setPosition(0)}
								className="min-h-11 border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-slate-200 hover:border-violet-300/40 hover:bg-white/10 hover:text-white focus-visible:outline-violet-300 rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								{t("showOriginal")}
							</button>
							<button
								type="button"
								onClick={() => setPosition(100)}
								className="min-h-11 px-4 py-2 text-sm font-semibold text-white focus-visible:outline-violet-200 rounded-full bg-[#6c4dff] shadow-[0_10px_28px_-14px_rgba(108,77,255,0.95)] transition hover:bg-[#7d63ff] focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								{t("showEdit")}
							</button>
						</div>
					</div>

					<div className="border-white/10 p-2 sm:p-3 relative overflow-hidden rounded-[2rem] border bg-[#211a31] shadow-[0_34px_90px_-44px_rgba(108,77,255,0.75)]">
						<div className="relative aspect-[3/2] overflow-hidden rounded-[1.55rem]">
							<Image
								src="/examples/studio-before.svg"
								alt={t("beforeAlt")}
								fill
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
									<ArrowLeftRightIcon className="size-4" aria-hidden="true" />
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
								className="inset-0 absolute h-full w-full cursor-ew-resize touch-pan-y opacity-0"
							/>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
