import { getPlanUsageEstimate, getPublicConfig, PLAN_ENTITLEMENTS } from "@repo/config/client";
import { Logo } from "@repo/ui/components/logo";
import {
	ArrowRightIcon,
	BadgeCheckIcon,
	ChevronDownIcon,
	CircleDollarSignIcon,
	LockKeyholeIcon,
	ShieldCheckIcon,
	SparklesIcon,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { BeforeAfterDemo } from "./BeforeAfterDemo";
import { LandingGenerator } from "./LandingGenerator";
import { ShowcaseSection } from "./ShowcaseSection";

const faqKeys = ["realGeneration", "privateUploads", "restrictions", "formats"] as const;
const planKeys = ["free", "creator", "studio"] as const;

export async function LandingPage() {
	const locale = await getLocale();
	const t = await getTranslations();
	const publicConfig = getPublicConfig();
	const currency = new Intl.NumberFormat(locale, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	});

	return (
		<div className="min-h-screen bg-[#100d1b] text-[#f7f3ff]">
			<header className="top-0 border-white/10 backdrop-blur-xl sticky z-50 border-b bg-[#100d1b]/85 shadow-[0_12px_40px_-24px_rgba(0,0,0,0.9)]">
				<div className="min-h-16 gap-4 container flex items-center">
					<Link
						href="/"
						className="focus-visible:outline-violet-300 shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
						aria-label={publicConfig.brand.siteName}
					>
						<Logo
							className="text-white [&_svg]:text-violet-400"
							label={publicConfig.brand.siteName}
						/>
					</Link>
					<nav
						aria-label={t("common.menu.startEditing")}
						className="gap-1 text-sm font-medium text-slate-300 md:flex ml-auto hidden items-center"
					>
						<a
							className="px-3 py-2 hover:bg-white/5 hover:text-white focus-visible:outline-violet-300 rounded-lg transition focus-visible:outline-2 focus-visible:outline-offset-2"
							href="#examples"
						>
							{t("common.menu.examples")}
						</a>
						<a
							className="px-3 py-2 hover:bg-white/5 hover:text-white focus-visible:outline-violet-300 rounded-lg transition focus-visible:outline-2 focus-visible:outline-offset-2"
							href="#how-it-works"
						>
							{t("common.menu.howItWorks")}
						</a>
						<a
							className="px-3 py-2 hover:bg-white/5 hover:text-white focus-visible:outline-violet-300 rounded-lg transition focus-visible:outline-2 focus-visible:outline-offset-2"
							href="#pricing"
						>
							{t("common.menu.pricing")}
						</a>
						<a
							className="px-3 py-2 hover:bg-white/5 hover:text-white focus-visible:outline-violet-300 rounded-lg transition focus-visible:outline-2 focus-visible:outline-offset-2"
							href="#faq"
						>
							{t("common.menu.faq")}
						</a>
					</nav>
					<div className="gap-2 md:ml-3 ml-auto flex items-center">
						<Link
							href="/login"
							className="min-h-11 px-3 text-sm font-semibold text-slate-300 hover:bg-white/5 hover:text-white focus-visible:outline-violet-300 sm:px-4 inline-flex items-center rounded-xl transition focus-visible:outline-2 focus-visible:outline-offset-2"
						>
							{t("common.menu.login")}
						</Link>
						<a
							href="#image-editor"
							className="min-h-11 px-3 text-sm font-semibold text-white focus-visible:outline-violet-200 sm:px-4 inline-flex items-center rounded-xl bg-[#6c4dff] shadow-[0_10px_28px_-12px_rgba(108,77,255,0.9)] transition hover:bg-[#7d63ff] focus-visible:outline-2 focus-visible:outline-offset-2"
						>
							{t("common.menu.startEditing")}
						</a>
					</div>
				</div>
			</header>

			<main>
				<section
					id="image-editor"
					className="scroll-mt-20 py-12 sm:py-16 lg:py-20 relative overflow-hidden border-b border-[#2c2440] bg-[radial-gradient(circle_at_12%_8%,rgba(108,77,255,0.3),transparent_28rem),radial-gradient(circle_at_88%_28%,rgba(255,182,122,0.14),transparent_24rem),linear-gradient(180deg,#171321_0%,#100d1b_100%)]"
				>
					<div
						className="inset-x-0 top-0 via-violet-300/50 pointer-events-none absolute h-px bg-gradient-to-r from-transparent to-transparent"
						aria-hidden="true"
					/>
					<div
						className="-top-60 h-96 bg-violet-500/10 blur-3xl pointer-events-none absolute left-1/2 w-[70rem] -translate-x-1/2 rounded-full"
						aria-hidden="true"
					/>
					<div className="relative container">
						<div className="max-w-4xl mx-auto text-center">
							<div className="gap-2 border-violet-300/25 bg-violet-300/10 px-3 py-1.5 text-xs font-bold text-violet-200 backdrop-blur inline-flex items-center rounded-full border tracking-[0.12em] uppercase shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
								<SparklesIcon className="size-3.5" aria-hidden="true" />
								{t("home.imageEditorHero.eyebrow")}
							</div>
							<h1 className="mt-5 max-w-5xl text-4xl font-semibold text-white sm:text-5xl lg:text-6xl mx-auto leading-[1.02] tracking-[-0.045em] text-balance">
								{t("home.imageEditorHero.title")}
							</h1>
							<p className="mt-5 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg mx-auto text-balance">
								{t("home.imageEditorHero.subtitle")}
							</p>
							<div className="mt-5 gap-x-5 gap-y-2 text-sm font-medium text-slate-300 flex flex-wrap items-center justify-center">
								<span className="gap-1.5 inline-flex items-center">
									<ShieldCheckIcon className="size-4 text-emerald-300" aria-hidden="true" />
									{t("home.imageEditorHero.private")}
								</span>
								<span className="gap-1.5 inline-flex items-center">
									<BadgeCheckIcon className="size-4 text-violet-300" aria-hidden="true" />
									{t("home.imageEditorHero.draftOnly")}
								</span>
							</div>
						</div>

						<LandingGenerator />
					</div>
				</section>

				<BeforeAfterDemo />
				<ShowcaseSection />

				<section
					id="how-it-works"
					className="scroll-mt-20 py-14 text-white sm:py-20 border-y border-[#2c2440] bg-[#100d1b]"
				>
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
						<div className="mt-10 gap-4 md:grid-cols-3 grid">
							{(["draft", "signin", "generate"] as const).map((key, index) => (
								<article
									key={key}
									className="border-white/10 bg-white/[0.045] p-6 rounded-[1.5rem] border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
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
					</div>
				</section>

				<section
					id="pricing"
					className="scroll-mt-20 py-14 sm:py-20 border-b border-[#2c2440] bg-[#171321]"
				>
					<div className="container">
						<div className="max-w-3xl mx-auto text-center">
							<h2 className="text-3xl font-semibold text-white sm:text-4xl tracking-[-0.035em]">
								{t("pricing.title")}
							</h2>
							<p className="mt-4 text-base leading-7 text-slate-300">{t("pricing.description")}</p>
						</div>
						<div className="mt-9 gap-4 lg:grid-cols-3 grid">
							{planKeys.map((planId) => {
								const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === planId);
								if (!entitlement) return null;
								const monthlyPrice = entitlement.prices.find((price) => price.interval === "month");
								const usage = getPlanUsageEstimate(entitlement.id);
								const translatedFeatures = Object.values(
									t.raw(`pricing.products.${planId}.features`) as Record<string, string>,
								);
								return (
									<article
										key={planId}
										className={`bg-white/[0.045] p-6 relative flex flex-col overflow-hidden rounded-3xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${
											planId === "creator"
												? "border-violet-400/70 bg-violet-400/[0.08] shadow-[0_24px_70px_-36px_rgba(108,77,255,0.85)]"
												: "border-white/10"
										}`}
									>
										<div>
											<h3 className="text-2xl font-semibold text-white">
												{t(`pricing.products.${planId}.title`)}
											</h3>
											<p className="mt-2 text-sm leading-6 text-slate-300">
												{t(`pricing.products.${planId}.description`)}
											</p>
											<p className="mt-5 text-3xl font-semibold text-white">
												{monthlyPrice ? currency.format(monthlyPrice.amount) : currency.format(0)}
												<span className="text-sm font-normal text-slate-400">
													/{t("pricing.month", { count: 1 })}
												</span>
											</p>
											<ul className="mt-5 space-y-3 text-sm text-slate-300">
												<li className="gap-2 flex">
													<CircleDollarSignIcon
														className="mt-0.5 size-4 text-violet-300 shrink-0"
														aria-hidden="true"
													/>
													{t("pricing.monthlyCredits", {
														credits: entitlement.monthlyCredits,
													})}
												</li>
												<li className="gap-2 flex">
													<BadgeCheckIcon
														className="mt-0.5 size-4 text-emerald-300 shrink-0"
														aria-hidden="true"
													/>
													{usage.qualityEdits === null
														? t("pricing.monthlyStandardAllowance", {
																standard: usage.standardEdits,
															})
														: t("pricing.monthlyEditAllowance", {
																standard: usage.standardEdits,
																quality: usage.qualityEdits,
															})}
												</li>
												<li className="gap-2 flex">
													<BadgeCheckIcon
														className="mt-0.5 size-4 text-emerald-300 shrink-0"
														aria-hidden="true"
													/>
													{t("pricing.creditExpiry")}
												</li>
												{translatedFeatures.slice(0, 3).map((feature) => (
													<li key={feature} className="gap-2 flex">
														<BadgeCheckIcon
															className="mt-0.5 size-4 text-emerald-300 shrink-0"
															aria-hidden="true"
														/>
														{feature}
													</li>
												))}
											</ul>
										</div>
										<Link
											href="/signup"
											className="mt-7 min-h-12 px-4 text-sm font-semibold text-white focus-visible:outline-violet-200 lg:mt-auto inline-flex items-center justify-center rounded-xl bg-[#6c4dff] shadow-[0_12px_30px_-16px_rgba(108,77,255,0.95)] transition hover:bg-[#7d63ff] focus-visible:outline-2 focus-visible:outline-offset-2"
										>
											{t("pricing.getStarted")}
											<ArrowRightIcon className="ml-2 size-4" aria-hidden="true" />
										</Link>
									</article>
								);
							})}
						</div>
					</div>
				</section>

				<section id="faq" className="scroll-mt-20 py-14 sm:py-20 bg-[#100d1b]">
					<div className="max-w-3xl container">
						<div className="text-center">
							<h2 className="text-3xl font-semibold text-white sm:text-4xl tracking-[-0.035em]">
								{t("faq.title")}
							</h2>
							<p className="mt-3 text-base leading-7 text-slate-300">{t("faq.description")}</p>
						</div>
						<div className="mt-8 space-y-3">
							{faqKeys.map((key) => (
								<details
									key={key}
									className="group border-white/10 bg-white/[0.045] p-5 open:border-violet-400/40 open:bg-white/[0.07] rounded-2xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition"
								>
									<summary className="font-semibold text-white focus-visible:outline-violet-300 gap-4 flex cursor-pointer list-none items-center justify-between rounded-md marker:hidden focus-visible:outline-2 focus-visible:outline-offset-4">
										<span>{t(`faq.items.${key}.question`)}</span>
										<ChevronDownIcon
											className="size-4 text-violet-300 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
											aria-hidden="true"
										/>
									</summary>
									<p className="mt-3 text-sm leading-6 text-slate-300">
										{t(`faq.items.${key}.answer`)}
									</p>
								</details>
							))}
						</div>
					</div>
				</section>

				<section className="py-12 text-white sm:py-16 border-t border-[#2c2440] bg-[#100d1b]">
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

			<footer className="py-8 border-t border-[#2c2440] bg-[#0c0914]">
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
							href="/login"
							className="rounded hover:text-white focus-visible:outline-violet-300 focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							{t("common.menu.login")}
						</Link>
						<Link
							href="/signup"
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
						<span className="gap-1.5 text-xs text-slate-400 inline-flex items-center">
							<LockKeyholeIcon className="size-3.5" aria-hidden="true" />
							{t("home.imageEditorHero.private")}
						</span>
					</div>
				</div>
			</footer>
		</div>
	);
}
