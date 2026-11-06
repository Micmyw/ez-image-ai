"use client";

import {
	isSourceTemplateKey,
	videoTemplateDescriptionKey,
	VIDEO_TEMPLATE_LIBRARY,
} from "@repo/config/video-template-library";
import { ArrowUpRightIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

import { TemplatePreview, TemplatePreviewProvider } from "./TemplatePreview";

export function TemplateDirectory({ initialAssetId = null }: { initialAssetId?: string | null }) {
	const t = useTranslations("videoTemplates");
	const [interactive, setInteractive] = useState(false);
	useEffect(() => setInteractive(true), []);
	const [category, setCategory] = useState("all");
	const [search, setSearch] = useState("");
	const items = VIDEO_TEMPLATE_LIBRARY.filter(
		(item) =>
			(category === "all" || item.category === category) &&
			`${item.name} ${t(`descriptions.${videoTemplateDescriptionKey(item)}`)}`
				.toLocaleLowerCase()
				.includes(search.toLocaleLowerCase().trim()),
	);
	const previewItems = items.filter((item) => item.sample);
	const linkedItems = items.filter((item) => !item.sample);
	return (
		<TemplatePreviewProvider>
			<section aria-label={t("directory")}>
				<div className="vt-toolbar">
					<div className="vt-filters" aria-label={t("filter")}>
						{(["all", "rap", "dance", "pets", "cinematic"] as const).map((value) => (
							<button
								type="button"
								disabled={!interactive}
								key={value}
								aria-pressed={category === value}
								onClick={() => setCategory(value)}
							>
								{t(`categories.${value}`)}
							</button>
						))}
					</div>
					<label className="vt-search">
						<SearchIcon aria-hidden />
						<input
							disabled={!interactive}
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={t("search")}
							aria-label={t("search")}
						/>
					</label>
				</div>
				<p className="vt-catalog-note">{t("availabilityNote")}</p>
				<div className="vt-grid">
					{previewItems.map((template, index) => (
						<article className="vt-card" key={template.key}>
							<TemplatePreview template={template} priority={index < 4} />
							<div className="vt-card-body">
								<div className="vt-card-meta">
									<span>{t(`categories.${template.category}`)}</span>
									<span>{t(`availability.${template.availability}`)}</span>
								</div>
								<h2>
									<Link
										href={
											initialAssetId && isSourceTemplateKey(template.key)
												? `${template.canonicalPath}?asset=${encodeURIComponent(initialAssetId)}`
												: template.canonicalPath
										}
										prefetch={false}
									>
										{template.name}
										<ArrowUpRightIcon aria-hidden />
									</Link>
								</h2>
								<p>{t(`descriptions.${videoTemplateDescriptionKey(template)}`)}</p>
								<div className="vt-card-spec">
									<span>{t(`inputs.${template.inputLabel}`)}</span>
									<span>{t(`audio.${template.audio}`)}</span>
								</div>
							</div>
						</article>
					))}
				</div>
				{linkedItems.length > 0 && (
					<section className="vt-linked-section" aria-label={t("moreTools")}>
						<h2>{t("moreTools")}</h2>
						<ul className="vt-linked-list">
							{linkedItems.map((template) => (
								<li key={template.key}>
									<div className="vt-card-meta">
										<span>{t(`categories.${template.category}`)}</span>
										<span>{t(`availability.${template.availability}`)}</span>
									</div>
									<h3>
										<Link href={template.canonicalPath} prefetch={false}>
											{template.name}
											<ArrowUpRightIcon aria-hidden />
										</Link>
									</h3>
									<p>{t(`descriptions.${videoTemplateDescriptionKey(template)}`)}</p>
									<div className="vt-card-spec">
										<span>{t(`inputs.${template.inputLabel}`)}</span>
										<span>{t(`audio.${template.audio}`)}</span>
									</div>
								</li>
							))}
						</ul>
					</section>
				)}
				{items.length === 0 && (
					<p className="vt-empty" aria-live="polite">
						{t("noResults")}
					</p>
				)}
			</section>
		</TemplatePreviewProvider>
	);
}
