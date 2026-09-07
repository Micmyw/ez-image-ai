"use client";

import {
	Building2Icon,
	InfoIcon,
	PaletteIcon,
	PauseIcon,
	PenToolIcon,
	PlayIcon,
	ShoppingBagIcon,
	SmartphoneIcon,
	SparklesIcon,
	UserRoundIcon,
	type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

type StoryKey = "ecommerce" | "brand" | "social" | "realEstate" | "portrait" | "conceptArt";

interface CreatorStory {
	key: StoryKey;
	initials: string;
	icon: LucideIcon;
	accentClassName: string;
}

const WORKFLOW_COLUMNS = [
	[
		{
			key: "ecommerce",
			initials: "MI",
			icon: ShoppingBagIcon,
			accentClassName: "bg-orange-300/12 text-orange-200",
		},
		{
			key: "portrait",
			initials: "NO",
			icon: UserRoundIcon,
			accentClassName: "bg-fuchsia-300/12 text-fuchsia-200",
		},
	],
	[
		{
			key: "brand",
			initials: "TH",
			icon: PenToolIcon,
			accentClassName: "bg-violet-300/12 text-violet-200",
		},
		{
			key: "realEstate",
			initials: "RA",
			icon: Building2Icon,
			accentClassName: "bg-cyan-300/12 text-cyan-200",
		},
	],
	[
		{
			key: "social",
			initials: "LE",
			icon: SmartphoneIcon,
			accentClassName: "bg-pink-300/12 text-pink-200",
		},
		{
			key: "conceptArt",
			initials: "IR",
			icon: PaletteIcon,
			accentClassName: "bg-emerald-300/12 text-emerald-200",
		},
	],
] as const satisfies readonly (readonly CreatorStory[])[];

const MOBILE_WORKFLOWS = WORKFLOW_COLUMNS.flat();
const COLUMN_SPEED_CLASSES = [
	"creator-workflows-track--one",
	"creator-workflows-track--two",
	"creator-workflows-track--three",
] as const;

export function CreatorWorkflowsSection() {
	const t = useTranslations("home.creatorWorkflows");
	const [isPaused, setIsPaused] = useState(false);

	function renderStoryCard(story: CreatorStory, duplicate: boolean) {
		const Icon = story.icon;

		return (
			<li
				key={`${story.key}-${duplicate ? "duplicate" : "primary"}`}
				data-test="creator-story-card"
				className="group border-white/9 p-5 backdrop-blur-sm hover:-translate-y-1 hover:border-violet-300/30 relative flex min-h-[15rem] flex-col overflow-hidden rounded-[1.35rem] border bg-[#21192c]/82 shadow-[0_24px_70px_-42px_rgba(0,0,0,0.95)] transition duration-300 hover:bg-[#281e36]/94 motion-reduce:transform-none motion-reduce:transition-none"
			>
				<div
					className="-right-12 -top-16 bg-violet-500/12 blur-3xl size-40 pointer-events-none absolute rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:transition-none"
					aria-hidden="true"
				/>
				<div className="gap-3 relative flex items-center">
					<span
						className={`size-11 ring-white/10 grid shrink-0 place-items-center rounded-full ring-1 ${story.accentClassName}`}
						aria-hidden="true"
					>
						<span className="text-xs font-bold tracking-[0.06em]">{story.initials}</span>
					</span>
					<span className="min-w-0">
						<span className="text-sm font-semibold text-white block truncate">
							{t(`cards.${story.key}.name`)}
						</span>
						<span className="mt-0.5 text-xs text-slate-400 block">
							{t(`cards.${story.key}.role`)}
						</span>
					</span>
					<Icon className="text-slate-500 ml-auto size-[1.05rem] shrink-0" aria-hidden="true" />
				</div>
				<h3 className="mt-5 text-lg font-semibold leading-snug text-white tracking-[-0.025em]">
					{t(`cards.${story.key}.title`)}
				</h3>
				<p className="mt-3 text-sm leading-6 text-slate-300">
					{t(`cards.${story.key}.description`)}
				</p>
				<div className="mt-5 bg-white/[0.045] p-3 ring-white/[0.055] rounded-xl ring-1">
					<p className="font-bold text-violet-200 text-[0.66rem] tracking-[0.13em] uppercase">
						{t("directionLabel")}
					</p>
					<p className="mt-1.5 text-sm font-medium leading-5 text-slate-200">
						{t(`cards.${story.key}.direction`)}
					</p>
				</div>
			</li>
		);
	}

	function renderWorkflowColumn(
		stories: readonly CreatorStory[],
		speedClassName: string,
		listLabel: string,
	) {
		return (
			<div className="creator-workflows-viewport">
				<div className={`creator-workflows-track ${speedClassName}`}>
					<ul className="creator-workflows-list" aria-label={listLabel}>
						{stories.map((story) => renderStoryCard(story, false))}
					</ul>
					<ul className="creator-workflows-list creator-workflows-duplicate" aria-hidden="true">
						{stories.map((story) => renderStoryCard(story, true))}
					</ul>
				</div>
			</div>
		);
	}

	return (
		<section
			id="creator-workflows"
			data-test="user-story-wall"
			aria-labelledby="creator-workflows-title"
			aria-describedby="creator-workflows-description creator-workflows-disclaimer"
			className="creator-workflows-section scroll-mt-20 py-16 text-white sm:py-24 relative overflow-hidden bg-transparent"
		>
			<div className="container">
				<div className="gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.6fr)] lg:text-left grid items-end text-center">
					<div>
						<p className="gap-2 text-xs font-bold text-violet-300 inline-flex items-center tracking-[0.16em] uppercase">
							<SparklesIcon className="size-3.5" aria-hidden="true" />
							{t("eyebrow")}
						</p>
						<h2
							id="creator-workflows-title"
							className="mt-3 max-w-4xl text-3xl font-semibold sm:text-4xl lg:text-5xl leading-[1.02] tracking-[-0.045em] text-balance"
						>
							{t("title")}
						</h2>
					</div>
					<div className="lg:justify-self-end">
						<p
							id="creator-workflows-description"
							className="max-w-xl text-base leading-7 text-slate-300 sm:text-lg"
						>
							{t("description")}
						</p>
						<button
							type="button"
							aria-controls="creator-workflows-motion"
							aria-pressed={isPaused}
							className="mt-5 min-h-11 gap-2 border-white/10 bg-white/[0.045] px-4 py-2 text-sm font-semibold text-slate-200 hover:border-violet-300/35 hover:bg-violet-300/10 hover:text-white focus-visible:outline-violet-300 inline-flex items-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:hidden"
							onClick={() => setIsPaused((paused) => !paused)}
						>
							{isPaused ? (
								<PlayIcon className="size-4" aria-hidden="true" />
							) : (
								<PauseIcon className="size-4" aria-hidden="true" />
							)}
							{isPaused ? t("resume") : t("pause")}
						</button>
					</div>
				</div>

				<div
					id="creator-workflows-motion"
					data-paused={isPaused}
					className="creator-workflows-motion mt-10 sm:mt-12"
				>
					<div className="md:hidden">
						{renderWorkflowColumn(
							MOBILE_WORKFLOWS,
							"creator-workflows-track--mobile",
							t("listLabel"),
						)}
					</div>
					<div className="gap-4 lg:gap-5 md:grid-cols-3 md:grid hidden">
						{WORKFLOW_COLUMNS.map((stories, columnIndex) => (
							<div key={stories[0].key}>
								{renderWorkflowColumn(
									stories,
									COLUMN_SPEED_CLASSES[columnIndex] ?? COLUMN_SPEED_CLASSES[0],
									t("columnLabel", { number: columnIndex + 1, total: WORKFLOW_COLUMNS.length }),
								)}
							</div>
						))}
					</div>
				</div>

				<p
					id="creator-workflows-disclaimer"
					className="mt-7 gap-2 max-w-3xl text-xs leading-5 text-slate-400 flex items-start"
				>
					<InfoIcon className="mt-0.5 size-3.5 text-violet-300 shrink-0" aria-hidden="true" />
					{t("disclaimer")}
				</p>
			</div>
		</section>
	);
}
