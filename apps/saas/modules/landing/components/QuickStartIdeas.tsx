import { getVideoTemplate } from "@repo/config/video-template-library";
import { ArrowUpRightIcon, ImageIcon, PlayIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";

import { publicPagePath } from "../../public-content/lib/indexing";
import { type HomepageShowcaseSlide } from "../lib/homepage-showcase";
import { HomepageShowcase } from "./HomepageShowcase";
import { QuickStartAction } from "./QuickStartAction";

import "./quick-start-ideas.css";

export async function QuickStartIdeas() {
	const locale = await getLocale();
	const t = await getTranslations();
	const createPath = publicPagePath("/create", locale);
	const examplePath = (key: string) =>
		`${createPath}${createPath.includes("?") ? "&" : "?"}example=${key}`;
	const pet = getVideoTemplate("kung-fu-cat")!;
	const previewSlides: HomepageShowcaseSlide[] = (
		[
			{
				key: "watercolor",
				kind: "comparison",
				before: "/images/image-to-image/style-before-960.03273c358179.webp",
				poster: "/images/image-to-image/style-after-960.0e5ba95642bc.webp",
				href: examplePath("watercolor"),
				prompt: t("home.quickStartPrompts.watercolor"),
			},
			{
				key: "vintage-photo",
				kind: "portrait",
				before: "/images/effects/1980s-ai-photo/input-adult-v1.webp",
				poster: "/images/effects/1980s-ai-photo/family-snapshot-v3.webp",
				href: examplePath("vintage-photo"),
				prompt: t("home.quickStartPrompts.vintagePhoto"),
			},
			{
				key: "christmas",
				kind: "gallery",
				poster: "/images/christmas/globe.webp",
				images: [
					"/images/christmas/street.webp",
					"/images/christmas/globe.webp",
					"/images/christmas/pet.webp",
				],
				href: publicPagePath("/christmas-wallpaper", locale),
			},
			{
				key: "green-booth-freestyle",
				kind: "video",
				poster: "/videos/homepage-showcase/green-booth-freestyle.webp",
				video: "/videos/homepage-showcase/green-booth-freestyle.mp4",
				href: publicPagePath(getVideoTemplate("green-booth-freestyle")!.canonicalPath, locale),
			},
		] as const
	).map((item) => ({
		...item,
		title: t(`home.showcasePopup.items.${item.key}.title`),
		label: t(`home.showcasePopup.items.${item.key}.label`),
		action: t(`home.showcasePopup.items.${item.key}.action`),
		description: t(`home.showcasePopup.items.${item.key}.description`),
	}));
	const previewCopy = {
		trigger: t("home.showcasePopup.trigger"),
		eyebrow: t("home.showcasePopup.eyebrow"),
		image: t("home.showcasePopup.image"),
		video: t("home.showcasePopup.video"),
		before: t("home.showcasePopup.before"),
		after: t("home.showcasePopup.after"),
		compare: t("home.showcasePopup.compare"),
		close: t("home.showcasePopup.close"),
		previous: t("home.showcasePopup.previous"),
		next: t("home.showcasePopup.next"),
		play: t("home.showcasePopup.play"),
		pause: t("home.showcasePopup.pause"),
		mute: t("home.showcasePopup.mute"),
		unmute: t("home.showcasePopup.unmute"),
		retry: t("home.showcasePopup.retry"),
		progress: t("home.showcasePopup.progress"),
	};
	const cards = [
		{
			key: "christmas",
			copy: "christmas",
			href: publicPagePath("/christmas-wallpaper", locale),
			image: "/images/christmas/globe.webp",
			video: false,
		},
		{
			key: "restore-photo",
			copy: "restorePhoto",
			href: examplePath("restore-photo"),
			image: "/images/effects/1980s-ai-photo/family-snapshot-v3.webp",
			prompt: t("home.quickStartPrompts.restorePhoto"),
			video: false,
		},
		{
			key: "birthday-card",
			copy: "birthdayCard",
			href: examplePath("birthday-card"),
			image: "/images/quick-start/birthday-card.webp",
			prompt: t("home.quickStartPrompts.birthdayCard"),
			video: false,
		},
		{
			key: "kung-fu-cat",
			copy: "kungFuCat",
			href: publicPagePath(pet.canonicalPath, locale),
			image: "/images/quick-start/kung-fu-cat.webp",
			video: true,
		},
	] as const;
	return (
		<section
			id="quick-start"
			className="quick-start container"
			aria-labelledby="quick-start-title"
			data-editor-dock-clear=""
		>
			<div className="quick-start-heading">
				<div>
					<p className="quick-start-eyebrow">{t("home.quickStart.eyebrow")}</p>
					<h2 id="quick-start-title">{t("home.quickStart.title")}</h2>
					<p className="quick-start-description">{t("home.quickStart.description")}</p>
				</div>
				<div className="quick-start-links">
					<HomepageShowcase slides={previewSlides} copy={previewCopy} />
					<Link
						href={publicPagePath("/video-templates", locale)}
						prefetch={false}
						className="quick-start-more"
					>
						{t("home.quickStart.more")} <ArrowUpRightIcon size={16} aria-hidden="true" />
					</Link>
				</div>
			</div>
			<div className="quick-start-grid">
				{cards.map((card) => (
					<QuickStartAction
						key={card.key}
						idea={card.key}
						href={card.href}
						prompt={"prompt" in card ? card.prompt : undefined}
					>
						<div className={`quick-start-art quick-start-art--${card.key}`}>
							<Image
								src={card.image}
								alt={t(`home.quickStart.items.${card.copy}.alt`)}
								fill
								sizes="(min-width: 1280px) 23vw, (min-width: 768px) 35vw, 46vw"
								loading="lazy"
							/>
							<span className="quick-start-kind">
								{card.video ? (
									<PlayIcon size={12} aria-hidden="true" />
								) : (
									<ImageIcon size={12} aria-hidden="true" />
								)}
								{t(card.video ? "home.quickStart.video" : "home.quickStart.image")}
							</span>
							<span className="quick-start-input">
								{t(`home.quickStart.items.${card.copy}.input`)}
							</span>
						</div>
						<div className="quick-start-copy">
							<h3>{t(`home.quickStart.items.${card.copy}.title`)}</h3>
							<p>{t(`home.quickStart.items.${card.copy}.description`)}</p>
							<span className="quick-start-cta">
								{t(`home.quickStart.items.${card.copy}.action`)}
								<ArrowUpRightIcon size={17} aria-hidden="true" />
							</span>
						</div>
					</QuickStartAction>
				))}
			</div>
		</section>
	);
}
