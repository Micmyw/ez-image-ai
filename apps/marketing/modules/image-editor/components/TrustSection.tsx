"use client";

import { CircleDollarSignIcon, LockKeyholeIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";

const ITEMS = [
	{ key: "privacy", icon: LockKeyholeIcon },
	{ key: "credits", icon: CircleDollarSignIcon },
	{ key: "safety", icon: ShieldCheckIcon },
] as const;

export function TrustSection() {
	const t = useTranslations("home.trust");

	return (
		<section id="trust" aria-labelledby="trust-title" className="py-14 sm:py-20">
			<div className="container">
				<div className="gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-end grid">
					<div>
						<p className="text-xs font-bold text-indigo-700 tracking-[0.16em] uppercase">
							{t("eyebrow")}
						</p>
						<h2
							id="trust-title"
							className="mt-3 text-3xl font-semibold text-slate-950 sm:text-4xl tracking-[-0.035em]"
						>
							{t("title")}
						</h2>
						<p className="mt-4 text-base leading-7 text-slate-600">{t("description")}</p>
					</div>

					<div className="gap-3 sm:grid-cols-3 grid">
						{ITEMS.map(({ key, icon: Icon }) => (
							<article
								key={key}
								className="border-slate-200 bg-white p-5 shadow-sm rounded-3xl border"
							>
								<Icon className="size-5 text-emerald-600" aria-hidden="true" />
								<h3 className="mt-4 text-base font-bold text-slate-950">
									{t(`items.${key}.title`)}
								</h3>
								<p className="mt-2 text-sm leading-6 text-slate-600">
									{t(`items.${key}.description`)}
								</p>
							</article>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
