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
import {
	ArrowDownIcon,
	ArrowUpRightIcon,
	ChevronDownIcon,
	ImagePlusIcon,
	PencilLineIcon,
	ScanEyeIcon,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { ImageToImageExamples } from "./ImageToImageExamples";
import { LandingGenerator } from "./LandingGenerator";

import "./image-to-image.css";

const useCases = ["background", "portrait", "style"] as const;
const steps = [
	{ key: "upload", Icon: ImagePlusIcon },
	{ key: "prompt", Icon: PencilLineIcon },
	{ key: "generate", Icon: ScanEyeIcon },
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
						<div className="mt-6">
							<Suspense fallback={<p className="p-6 text-slate-300 text-center">{t("loading")}</p>}>
								{registered ? (
									<RegisteredWorkspaceBoundary>
										<MainAccountBoundary>
											<RegisteredEditor searchParams={searchParams} />
										</MainAccountBoundary>
									</RegisteredWorkspaceBoundary>
								) : (
									<LandingGenerator />
								)}
							</Suspense>
						</div>
						<div className="mt-6 flex justify-center">
							<a
								href="#image-to-image-examples"
								className="min-h-11 gap-2 px-4 text-xs text-violet-200 hover:bg-white/5 focus-visible:outline-violet-300 inline-flex items-center rounded-lg focus-visible:outline-2"
							>
								{t("examples.explore")} <ArrowDownIcon size={14} aria-hidden="true" />
							</a>
						</div>
					</div>
				</section>

				<ImageToImageExamples
					items={useCases.map((key) => ({
						key,
						label: t(`examples.${key}.label`),
						title: t(`useCases.${key}.title`),
						body: t(`useCases.${key}.body`),
						prompt: t(`useCases.${key}.prompt`),
						beforeAlt: t(`examples.${key}.beforeAlt`),
						afterAlt: t(`examples.${key}.afterAlt`),
					}))}
					labels={{
						title: t("useCases.title"),
						intro: t("useCases.intro"),
						choose: t("examples.choose"),
						before: t("examples.before"),
						after: t("examples.after"),
						compare: t("examples.compare"),
						drag: t("examples.drag"),
						prompt: t("promptLabel"),
						usePrompt: t("usePrompt"),
						promptAdded: t("examples.promptAdded"),
						ownImage: t("examples.ownImage"),
						note: t("examples.note"),
					}}
				/>

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
					<div className="mt-9 gap-8 md:grid-cols-3 grid">
						{steps.map(({ key, Icon }, index) => (
							<article key={key} className="border-violet-300/25 pt-6 relative border-t">
								<div className="flex items-center justify-between">
									<Icon
										className="size-10 bg-violet-300/10 p-2.5 text-violet-200 rounded-xl"
										aria-hidden="true"
									/>
									<span className="font-mono text-xs text-violet-300/70">0{index + 1}</span>
								</div>
								<h3 className="mt-4 text-lg font-semibold">{t(`how.steps.${key}.title`)}</h3>
								<p className="mt-3 text-sm leading-6 text-slate-300">
									{t(`how.steps.${key}.body`)}
								</p>
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
					className="image-edit-faq container"
					data-editor-end=""
					aria-labelledby="image-to-image-faq"
				>
					<h2 id="image-to-image-faq" className="image-edit-faq-title">
						{t("faq.title")}
					</h2>
					<div className="image-edit-faq-content">
						{faqKeys.map((key) => (
							<details key={key} className="image-edit-faq-item group">
								<summary className="gap-4 rounded focus-visible:outline-violet-300 flex cursor-pointer list-none items-center justify-between marker:hidden focus-visible:outline-2 focus-visible:outline-offset-4">
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
						<a href="#image-editor" className="image-edit-return-link">
							{t("startAgain")}
							<ArrowUpRightIcon size={18} aria-hidden="true" />
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
