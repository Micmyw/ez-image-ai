"use client";

import { ArrowUpRightIcon, CheckIcon, MousePointerClickIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type ReactNode, useState } from "react";

import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../lib/prompt-selection";
import { SHOWCASE_ITEMS } from "../lib/showcase-items";
import { LandingArtwork } from "./LandingArtwork";

import "./showcase.css";

export function ShowcaseSection({ standalone = false }: { standalone?: boolean } = {}) {
	const t = useTranslations("home.showcase");
	const Heading = standalone ? "h1" : "h2";
	const [selectedKey, setSelectedKey] = useState<(typeof SHOWCASE_ITEMS)[number]["key"]>();

	function usePrompt(key: (typeof SHOWCASE_ITEMS)[number]["key"]) {
		const prompt = t(`items.${key}.prompt`);
		setSelectedKey(key);
		window.dispatchEvent(
			new CustomEvent<LandingPromptSelectedDetail>(LANDING_PROMPT_SELECTED_EVENT, {
				detail: { prompt },
			}),
		);
	}

	return (
		<section
			id="examples"
			data-editor-dock-clear=""
			aria-labelledby="examples-title"
			className="showcase-section scroll-mt-20 py-14 text-white sm:py-20 relative overflow-hidden bg-transparent"
		>
			<div className="relative container">
				<div className="showcase-heading gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.55fr)] lg:text-left grid items-end text-center">
					<div>
						<p className="gap-2 text-xs font-bold text-violet-300 inline-flex items-center tracking-[0.16em] uppercase">
							<SparklesIcon className="size-3.5" aria-hidden="true" />
							{t("eyebrow")}
						</p>
						<Heading
							id="examples-title"
							className="mt-3 max-w-4xl text-3xl font-semibold sm:text-4xl lg:text-5xl leading-[1.02] tracking-[-0.045em] text-balance"
						>
							{t("title")}
						</Heading>
					</div>
					<div className="lg:justify-self-end">
						<p className="max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
							{t("description")}
						</p>
						<p className="mt-4 gap-2 text-sm font-semibold text-orange-200 inline-flex items-center">
							<MousePointerClickIcon className="size-4" aria-hidden="true" />
							{t("instruction")}
						</p>
					</div>
				</div>

				<div className="showcase-grid">
					{SHOWCASE_ITEMS.map((item) => (
						<article
							key={item.key}
							className="showcase-card"
							data-orientation={item.width > item.height ? "landscape" : "portrait"}
							data-selected={selectedKey === item.key || undefined}
						>
							<ShowcasePromptAction
								standalone={standalone}
								exampleKey={item.key}
								selected={selectedKey === item.key}
								onSelect={() => usePrompt(item.key)}
							>
								<div className="showcase-artwork">
									<LandingArtwork
										src={item.image}
										alt={t(`items.${item.key}.alt`)}
										className="block h-auto w-full"
										sizes="(min-width: 1280px) 300px, (min-width: 900px) 33vw, 50vw"
									/>
									<span className="showcase-tag">{t(`items.${item.key}.tag`)}</span>
								</div>
								<div className="showcase-caption">
									<h3 className="sr-only">{t(`items.${item.key}.title`)}</h3>
									<p>{t(`items.${item.key}.prompt`)}</p>
									<span className="showcase-action">
										{selectedKey === item.key ? t("promptAdded") : t("usePrompt")}
										{selectedKey === item.key ? (
											<CheckIcon size={16} aria-hidden="true" />
										) : (
											<ArrowUpRightIcon size={16} aria-hidden="true" />
										)}
									</span>
								</div>
							</ShowcasePromptAction>
						</article>
					))}
				</div>
				<p className="mt-6 max-w-3xl text-xs leading-5 text-slate-400">{t("provenanceNote")}</p>
			</div>
		</section>
	);
}

function ShowcasePromptAction({
	standalone,
	exampleKey,
	selected,
	onSelect,
	children,
}: {
	standalone: boolean;
	exampleKey: string;
	selected: boolean;
	onSelect: () => void;
	children: ReactNode;
}) {
	const className =
		"showcase-trigger @container relative block w-full overflow-hidden text-left focus-visible:outline-none";
	return standalone ? (
		<Link className={className} href={`/create?example=${exampleKey}`}>
			{children}
		</Link>
	) : (
		<button type="button" className={className} aria-pressed={selected} onClick={onSelect}>
			{children}
		</button>
	);
}
