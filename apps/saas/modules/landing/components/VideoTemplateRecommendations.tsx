import { VIDEO_TEMPLATE_LIBRARY } from "@repo/config/video-template-library";
import { ArrowRightIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";

import { publicPagePath } from "../../public-content/lib/indexing";

const featuredKeys = ["bulin-47", "spin-me-round", "58th-floor", "kung-fu-cat"];

/** Static discovery only: the homepage never mounts a template player or workspace. */
export async function VideoTemplateRecommendations() {
	const locale = await getLocale();
	const t = await getTranslations("videoTemplates.home");
	const templates = featuredKeys.flatMap((key) => {
		const template = VIDEO_TEMPLATE_LIBRARY.find((entry) => entry.key === key);
		return template?.sample ? [template] : [];
	});
	return (
		<section
			className="py-12 text-white sm:py-16 container"
			aria-labelledby="video-template-heading"
		>
			<div className="mb-6 gap-5 flex flex-wrap items-end justify-between">
				<div className="max-w-2xl">
					<p className="text-xs font-bold text-violet-300 tracking-[0.16em] uppercase">
						{t("eyebrow")}
					</p>
					<h2 id="video-template-heading" className="mt-3 text-3xl font-semibold tracking-tight">
						{t("title")}
					</h2>
					<p className="mt-3 text-sm leading-6 text-slate-300">{t("description")}</p>
				</div>
				<Link
					href={publicPagePath("/video-templates", locale)}
					prefetch={false}
					className="min-h-11 gap-2 px-2 text-sm font-semibold text-violet-200 hover:text-white focus-visible:outline-violet-300 inline-flex items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
				>
					{t("action")} <ArrowRightIcon className="size-4" aria-hidden="true" />
				</Link>
			</div>
			<div className="gap-4 lg:grid-cols-4 grid grid-cols-2">
				{templates.map((template) => (
					<Link
						key={template.key}
						href={publicPagePath(template.canonicalPath, locale)}
						prefetch={false}
						className="group border-white/10 bg-white/[0.035] focus-visible:outline-violet-300 overflow-hidden rounded-2xl border focus-visible:outline-2 focus-visible:outline-offset-4"
					>
						<div className="bg-slate-900 relative aspect-[4/3] overflow-hidden">
							<Image
								src={template.sample!.poster}
								alt={template.name}
								fill
								sizes="(min-width: 1024px) 280px, (min-width: 640px) 45vw, 46vw"
								loading="lazy"
								className="object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transform-none motion-reduce:transition-none"
							/>
						</div>
						<div className="p-4">
							<h3 className="text-sm font-semibold sm:text-base">{template.name}</h3>
							<p className="mt-1 text-xs text-slate-400">{t("sourceSample")}</p>
						</div>
					</Link>
				))}
			</div>
		</section>
	);
}
