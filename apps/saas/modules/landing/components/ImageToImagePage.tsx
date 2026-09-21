import { getSession } from "@auth/lib/server";
import {
	RegisteredEditor,
	type CreatePageFilters,
} from "@media/components/editor/RegisteredEditor";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { MainAccountBoundary } from "@shared/components/MainAccountBoundary";
import { RegisteredWorkspaceBoundary } from "@shared/components/RegisteredWorkspaceBoundary";
import { StudioShell } from "@shared/components/studio/StudioShell";
import { getBaseUrl } from "@shared/lib/base-url";
import { ChevronDownIcon, ImagePlusIcon, PaintbrushIcon, SunIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { ImageToImagePrompt } from "./ImageToImagePrompt";
import { LandingGenerator } from "./LandingGenerator";

const useCases = [
	{ key: "background", Icon: ImagePlusIcon },
	{ key: "portrait", Icon: SunIcon },
	{ key: "style", Icon: PaintbrushIcon },
] as const;
const faqKeys = ["definition", "free", "control", "privacy", "limits"] as const;

export async function ImageToImagePage({
	searchParams = Promise.resolve({}),
}: {
	searchParams?: Promise<CreatePageFilters>;
}) {
	const [session, t, locale] = await Promise.all([
		getSession(),
		getTranslations("imageToImage"),
		getLocale(),
	]);
	const registered = Boolean(session && !isAnonymousUser(session.user));
	const canonical = new URL("/image-to-image", getBaseUrl()).href;
	const structuredData = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				name: t("name"),
				headline: t("title"),
				url: canonical,
				inLanguage: locale,
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{
						"@type": "ListItem",
						position: 1,
						name: "EzImageAI",
						item: new URL("/", getBaseUrl()).href,
					},
					{ "@type": "ListItem", position: 2, name: t("name"), item: canonical },
				],
			},
		],
	};
	return (
		<StudioShell brandName="EzImageAI">
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
				}}
			/>
			<main
				className="studio-home text-white bg-[radial-gradient(circle_at_50%_-8rem,rgba(169,139,255,0.17),transparent_34rem)]"
				data-image-to-image-page=""
			>
				<section id="image-editor" className="studio-hero scroll-mt-16">
					<div className="container">
						<nav
							aria-label={t("breadcrumb")}
							className="mb-6 gap-2 text-xs text-slate-400 flex flex-wrap items-center justify-center"
						>
							<Link href="/" className="rounded hover:text-white focus-visible:outline-violet-300">
								{t("home")}
							</Link>
							<span aria-hidden="true">/</span>
							<span aria-current="page">{t("name")}</span>
						</nav>
						<div className="max-w-4xl mx-auto text-center">
							<h1 className="studio-title max-w-4xl font-semibold mx-auto text-balance text-[#f6f2fb]">
								{t("title")}
							</h1>
							<p className="mt-3 max-w-2xl text-sm leading-6 mx-auto text-balance text-[#b7acbf]">
								{t("subtitle")}
							</p>
						</div>
						<div className="mt-6" data-reference-only="true">
							<Suspense fallback={<p className="p-6 text-slate-300 text-center">{t("loading")}</p>}>
								{registered ? (
									<RegisteredWorkspaceBoundary>
										<MainAccountBoundary>
											<RegisteredEditor searchParams={searchParams} />
										</MainAccountBoundary>
									</RegisteredWorkspaceBoundary>
								) : (
									<LandingGenerator requireReference />
								)}
							</Suspense>
						</div>
					</div>
				</section>

				<section className="py-14 sm:py-20 container" aria-labelledby="image-to-image-how">
					<div className="max-w-3xl mx-auto text-center">
						<h2
							id="image-to-image-how"
							className="text-3xl font-semibold tracking-tight sm:text-4xl"
						>
							{t("how.title")}
						</h2>
						<p className="mt-4 text-base leading-7 text-slate-300">{t("how.description")}</p>
					</div>
					<div className="mt-9 gap-5 md:grid-cols-3 grid">
						{(["upload", "prompt", "generate"] as const).map((key, index) => (
							<article
								key={key}
								className="border-white/10 bg-white/[0.035] p-6 rounded-2xl border"
							>
								<span className="font-mono text-sm text-violet-300">0{index + 1}</span>
								<h3 className="mt-4 text-lg font-semibold">{t(`how.steps.${key}.title`)}</h3>
								<p className="mt-3 text-sm leading-6 text-slate-300">
									{t(`how.steps.${key}.body`)}
								</p>
							</article>
						))}
					</div>
				</section>

				<section className="py-14 sm:py-20 container" aria-labelledby="image-to-image-prompts">
					<div className="max-w-3xl">
						<h2
							id="image-to-image-prompts"
							className="text-3xl font-semibold tracking-tight sm:text-4xl"
						>
							{t("useCases.title")}
						</h2>
						<p className="mt-4 text-base leading-7 text-slate-300">{t("useCases.intro")}</p>
					</div>
					<div className="mt-9 gap-5 lg:grid-cols-3 grid">
						{useCases.map(({ key, Icon }) => (
							<article
								key={key}
								className="min-w-0 border-violet-300/15 bg-violet-300/[0.045] p-6 flex flex-col rounded-2xl border"
							>
								<Icon className="size-6 text-violet-300" aria-hidden="true" />
								<h3 className="mt-5 text-xl font-semibold">{t(`useCases.${key}.title`)}</h3>
								<p className="mb-5 mt-3 text-sm leading-6 text-slate-300">
									{t(`useCases.${key}.body`)}
								</p>
								<div className="bg-black/20 p-4 mt-auto rounded-xl">
									<p className="mb-2 text-xs font-semibold text-violet-300">{t("promptLabel")}</p>
									<blockquote className="text-sm leading-6 text-slate-200">
										{t(`useCases.${key}.prompt`)}
									</blockquote>
								</div>
								<ImageToImagePrompt prompt={t(`useCases.${key}.prompt`)} label={t("usePrompt")} />
							</article>
						))}
					</div>
				</section>

				<section className="py-14 sm:py-20 container" aria-labelledby="image-to-image-guide">
					<div className="border-white/10 p-6 sm:p-9 rounded-2xl border">
						<h2 id="image-to-image-guide" className="text-2xl font-semibold">
							{t("guide.title")}
						</h2>
						<p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">{t("guide.body")}</p>
						<div className="mt-5 gap-x-6 gap-y-3 text-sm text-violet-200 flex flex-wrap">
							<Link
								href="/docs/image-editing"
								className="hover:text-white underline underline-offset-4"
							>
								{t("guide.link")}
							</Link>
							<Link href="/create" className="hover:text-white underline underline-offset-4">
								{t("guide.textToImage")}
							</Link>
						</div>
					</div>
				</section>

				<section
					className="max-w-3xl py-14 sm:py-20 container"
					aria-labelledby="image-to-image-faq"
				>
					<h2
						id="image-to-image-faq"
						className="text-3xl font-semibold tracking-tight sm:text-4xl text-center"
					>
						{t("faq.title")}
					</h2>
					<div className="mt-8 space-y-3">
						{faqKeys.map((key) => (
							<details
								key={key}
								className="group border-white/10 bg-white/[0.035] p-5 open:border-violet-300/40 rounded-2xl border"
							>
								<summary className="gap-4 rounded font-semibold focus-visible:outline-violet-300 flex cursor-pointer list-none items-center justify-between marker:hidden focus-visible:outline-2 focus-visible:outline-offset-4">
									<span>{t(`faq.${key}.question`)}</span>
									<ChevronDownIcon
										className="size-4 text-violet-300 shrink-0 transition group-open:rotate-180 motion-reduce:transition-none"
										aria-hidden="true"
									/>
								</summary>
								<p className="mt-3 text-sm leading-7 text-slate-300">{t(`faq.${key}.answer`)}</p>
								{key === "free" && (
									<Link
										href="/pricing"
										className="mt-3 text-sm text-violet-200 inline-block underline underline-offset-4"
									>
										{t("pricing")}
									</Link>
								)}
							</details>
						))}
					</div>
					<div className="mt-9 text-center">
						<a
							href="#image-editor"
							className="min-h-12 bg-violet-600 px-6 font-semibold hover:bg-violet-500 focus-visible:outline-violet-300 inline-flex items-center rounded-xl transition focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							{t("startAgain")}
						</a>
					</div>
				</section>
				<footer className="gap-6 border-white/10 py-9 text-sm text-slate-400 sm:flex-row container flex flex-col items-center justify-between border-t">
					<Link href="/" className="font-semibold text-white">
						EzImageAI
					</Link>
					<PublicFooterLinks />
				</footer>
			</main>
		</StudioShell>
	);
}
