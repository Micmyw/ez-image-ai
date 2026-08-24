"use client";

import {
	ArrowRightIcon,
	EyeOffIcon,
	Layers3Icon,
	ListChecksIcon,
	MessageSquareTextIcon,
	ShieldAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

const BENEFITS = [
	{ key: "prompts", icon: MessageSquareTextIcon },
	{ key: "templates", icon: Layers3Icon },
	{ key: "privacy", icon: EyeOffIcon },
	{ key: "credits", icon: ListChecksIcon },
	{ key: "steps", icon: ArrowRightIcon },
] as const;

export function NoRestrictionsSection() {
	const t = useTranslations("home.noRestrictions");

	return (
		<section
			id="no-restrictions"
			aria-labelledby="no-restrictions-title"
			className="py-14 sm:py-20"
		>
			<div className="container">
				<div className="text-white shadow-xl shadow-slate-950/10 overflow-hidden rounded-[2.25rem] bg-[#111827]">
					<div className="lg:grid-cols-[0.82fr_1.18fr] grid">
						<div className="border-white/10 p-7 sm:p-10 lg:border-r lg:border-b-0 lg:p-12 relative border-b">
							<div
								className="inset-0 absolute opacity-30"
								style={{
									backgroundImage:
										"radial-gradient(circle at 18% 20%, rgba(34,211,238,.45), transparent 26%), radial-gradient(circle at 78% 72%, rgba(99,102,241,.5), transparent 32%)",
								}}
								aria-hidden="true"
							/>
							<div className="relative">
								<p className="text-xs font-bold text-cyan-300 tracking-[0.16em] uppercase">
									{t("eyebrow")}
								</p>
								<h2
									id="no-restrictions-title"
									className="mt-4 text-3xl leading-tight font-semibold sm:text-4xl tracking-[-0.04em]"
								>
									{t("title")}
								</h2>
								<p className="mt-4 text-base leading-7 text-slate-300">{t("description")}</p>
								<div className="mt-8 gap-3 border-amber-300/30 bg-amber-300/10 p-4 flex rounded-2xl border">
									<ShieldAlertIcon
										className="mt-0.5 size-5 text-amber-300 shrink-0"
										aria-hidden="true"
									/>
									<p className="text-sm leading-6 text-amber-50">{t("limits")}</p>
								</div>
							</div>
						</div>

						<div className="bg-white/10 sm:grid-cols-2 grid gap-px">
							{BENEFITS.map(({ key, icon: Icon }, index) => (
								<div
									key={key}
									className={`p-6 sm:p-8 bg-[#111827] ${index === BENEFITS.length - 1 ? "sm:col-span-2" : ""}`}
								>
									<Icon className="size-5 text-cyan-300" aria-hidden="true" />
									<h3 className="mt-4 text-base font-bold">{t(`items.${key}.title`)}</h3>
									<p className="mt-2 text-sm leading-6 text-slate-400">
										{t(`items.${key}.description`)}
									</p>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
