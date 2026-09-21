import { PublicPricingPlans } from "@payments/components/PublicPricingPlans";
import { getPublicConfig } from "@repo/config/client";
import { Logo } from "@repo/ui/components/logo";
import { StudioShell } from "@shared/components/studio/StudioShell";
import { ArrowRightIcon, ChevronDownIcon, LockKeyholeIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ReactNode } from "react";

import { ExploreModels } from "../../models/components/ExploreModels";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { HOME_FAQ_KEYS } from "../lib/faq";
import { BeforeAfterDemo } from "./BeforeAfterDemo";
import { CreatorWorkflowsSection } from "./CreatorWorkflowsSection";
import { LandingGenerator } from "./LandingGenerator";
import { ShowcaseSection } from "./ShowcaseSection";

export async function LandingPage({
	editor,
	workspace = false,
}: { editor?: ReactNode; workspace?: boolean } = {}) {
	const locale = await getLocale();
	const t = await getTranslations();
	const publicConfig = getPublicConfig();
	return (
		<StudioShell>
			<main className="studio-home relative bg-[radial-gradient(circle_at_50%_-8rem,rgba(169,139,255,0.17),transparent_34rem),radial-gradient(circle_at_94%_42%,rgba(255,183,124,0.08),transparent_32rem),radial-gradient(circle_at_4%_72%,rgba(108,77,255,0.08),transparent_34rem)]">
				<section id="image-editor" className="studio-hero scroll-mt-16">
					<div className="container">
						<div className="max-w-4xl mx-auto text-center">
							<h1 className="studio-title max-w-4xl font-semibold mx-auto text-balance text-[#f6f2fb]">
								{workspace
									? t("studio.tools.title")
									: t.rich("home.imageEditorHero.title", {
											accent: (children) => <span className="text-[#b79cff]">{children}</span>,
										})}
							</h1>
							<p className="mt-3 max-w-2xl text-sm leading-6 mx-auto text-balance text-[#b7acbf]">
								{editor || workspace ? t("studio.subtitle") : t("home.imageEditorHero.subtitle")}
							</p>
						</div>

						{editor ?? <LandingGenerator />}
					</div>
				</section>

				<ExploreModels />
				<ShowcaseSection />
				<BeforeAfterDemo />
				<CreatorWorkflowsSection />

				<section id="how-it-works" className="scroll-mt-20 py-20 text-white sm:py-28">
					<div className="container">
						<div className="max-w-3xl mx-auto text-center">
							<p className="text-xs font-bold text-violet-300 tracking-[0.16em] uppercase">
								{t("home.howItWorks.eyebrow")}
							</p>
							<h2 className="mt-3 text-3xl font-semibold sm:text-4xl tracking-[-0.035em]">
								{t("home.howItWorks.title")}
							</h2>
							<p className="mt-4 text-base leading-7 text-slate-300">
								{t("home.howItWorks.description")}
							</p>
						</div>
						<div className="mt-12 gap-5 md:grid-cols-3 grid">
							{(["draft", "signin", "generate"] as const).map((key, index) => (
								<article
									key={key}
									className="border-white/8 bg-white/[0.035] p-7 backdrop-blur-sm rounded-[1.75rem] border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
								>
									<span className="size-9 border-violet-300/20 bg-violet-300/10 font-mono text-xs font-bold text-violet-200 inline-flex items-center justify-center rounded-full border">
										0{index + 1}
									</span>
									<h3 className="mt-4 text-xl font-semibold">
										{t(`home.howItWorks.steps.${key}.title`)}
									</h3>
									<p className="mt-3 text-sm leading-6 text-slate-300">
										{t(`home.howItWorks.steps.${key}.description`)}
									</p>
								</article>
							))}
						</div>
						<div className="mt-8 gap-x-6 gap-y-3 text-sm text-violet-200 flex flex-wrap justify-center">
							<Link
								href="/docs/quick-start"
								className="hover:text-white underline underline-offset-4"
							>
								{t("home.guides.quickStart")}
							</Link>
							<Link
								href="/blog/ai-image-editing-prompts"
								className="hover:text-white underline underline-offset-4"
							>
								{t("home.guides.prompts")}
							</Link>
							<Link
								href="/blog/private-image-editing-workflow"
								className="hover:text-white underline underline-offset-4"
							>
								{t("home.guides.privacy")}
							</Link>
						</div>
					</div>
				</section>

				<section id="pricing" className="scroll-mt-20 py-20 sm:py-28">
					<div className="container">
						<div className="max-w-3xl mx-auto text-center">
							<h2 className="text-4xl font-semibold text-white sm:text-5xl tracking-[-0.045em]">
								{t("home.pricing.title")}
							</h2>
							<p className="mt-5 text-base leading-7 sm:text-lg text-[#b7acbf]">
								{t("home.pricing.description")}
							</p>
						</div>
						<PublicPricingPlans locale={locale} headingLevel={3} className="mt-10 sm:mt-12" />
					</div>
				</section>

				<section id="faq" className="scroll-mt-20 py-20 sm:py-28">
					<div className="max-w-3xl container">
						<div className="text-center">
							<h2 className="text-3xl font-semibold text-white sm:text-4xl tracking-[-0.035em]">
								{t("home.faq.title")}
							</h2>
							<p className="mt-3 text-base leading-7 text-slate-300">{t("home.faq.description")}</p>
						</div>
						<div className="mt-8 space-y-3">
							{HOME_FAQ_KEYS.map((key) => {
								const namespace =
									key === "guestAvailability" || key === "guestVsFree"
										? (`home.faq.items.${key}` as const)
										: (`faq.items.${key}` as const);
								return (
									<details
										key={key}
										className="group border-white/10 bg-white/[0.045] p-5 open:border-violet-400/40 open:bg-white/[0.07] rounded-2xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition"
									>
										<summary className="font-semibold text-white focus-visible:outline-violet-300 gap-4 flex cursor-pointer list-none items-center justify-between rounded-md marker:hidden focus-visible:outline-2 focus-visible:outline-offset-4">
											<span>{t(`${namespace}.question`)}</span>
											<ChevronDownIcon
												className="size-4 text-violet-300 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
												aria-hidden="true"
											/>
										</summary>
										<p className="mt-3 text-sm leading-6 text-slate-300">
											{t(`${namespace}.answer`)}
										</p>
									</details>
								);
							})}
						</div>
					</div>
				</section>

				<section className="py-14 text-white sm:py-20">
					<div className="container">
						<div className="gap-6 border-violet-300/20 px-6 py-9 md:flex-row md:px-9 md:text-left lg:px-12 relative flex flex-col items-center justify-between overflow-hidden rounded-[2rem] border bg-[radial-gradient(circle_at_12%_0%,rgba(108,77,255,0.42),transparent_24rem),radial-gradient(circle_at_92%_120%,rgba(255,182,122,0.22),transparent_22rem),#1b1430] text-center shadow-[0_28px_90px_-48px_rgba(108,77,255,0.8)]">
							<div>
								<p className="text-xs font-bold text-violet-200 tracking-[0.16em] uppercase">
									{t("home.finalCta.eyebrow")}
								</p>
								<h2 className="mt-2 text-3xl font-semibold">{t("home.finalCta.title")}</h2>
								<p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
									{t("home.finalCta.description")}
								</p>
							</div>
							<a
								href="#image-editor"
								className="min-h-12 px-5 text-sm font-semibold hover:bg-white focus-visible:outline-orange-200 inline-flex shrink-0 items-center rounded-xl bg-[#f7f3ff] text-[#34246f] shadow-[0_12px_36px_-18px_rgba(255,255,255,0.8)] transition focus-visible:outline-2 focus-visible:outline-offset-4"
							>
								{t("home.finalCta.button")}
								<ArrowRightIcon className="ml-2 size-4" aria-hidden="true" />
							</a>
						</div>
					</div>
				</section>
			</main>

			<footer className="py-10 bg-[#0f0b16]">
				<div className="gap-5 sm:flex-row sm:text-left container flex flex-col items-center justify-between text-center">
					<div>
						<Logo
							className="text-white [&_svg]:text-violet-400"
							label={publicConfig.brand.siteName}
						/>
						<p className="mt-2 max-w-lg text-xs leading-5 text-slate-400">
							{publicConfig.brand.siteDescription}
						</p>
					</div>
					<div className="gap-4 text-sm font-medium text-slate-300 flex flex-wrap items-center justify-center">
						<Link
							href={editor ? "/settings/general" : "/login"}
							className="rounded hover:text-white focus-visible:outline-violet-300 focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							{editor ? t("studio.panels.general") : t("common.menu.login")}
						</Link>
						<Link
							href={editor ? "#image-editor" : "/signup"}
							className="rounded hover:text-white focus-visible:outline-violet-300 focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							{t("common.menu.startEditing")}
						</Link>
						<a
							href="#pricing"
							className="rounded hover:text-white focus-visible:outline-violet-300 focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							{t("common.menu.pricing")}
						</a>
						<PublicFooterLinks className="contents" />
						<span className="gap-1.5 text-xs text-slate-400 inline-flex items-center">
							<LockKeyholeIcon className="size-3.5" aria-hidden="true" />
							{t("home.imageEditorHero.private")}
						</span>
					</div>
				</div>
			</footer>
		</StudioShell>
	);
}
