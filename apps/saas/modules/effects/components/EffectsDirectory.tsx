"use client";

import { SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";

import { CONTENT_PAGE_SIZE, contentPagePath } from "../../public-content/lib/pagination";
import { effectPath, type PublicEffect } from "../lib/types";
import { EffectCard } from "./EffectCard";

export function EffectsDirectory({ effects, page }: { effects: PublicEffect[]; page: number }) {
	const t = useTranslations("effects");
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("");
	const [filterPage, setFilterPage] = useState(1);
	const categories = [...new Set(effects.map((effect) => effect.primaryCategoryId))];
	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return effects.filter(
			(effect) =>
				(!category || effect.primaryCategoryId === category) &&
				(!query ||
					[effect.title, effect.summary, ...effect.tags].join(" ").toLowerCase().includes(query)),
		);
	}, [effects, search, category]);
	const filtering = Boolean(search.trim() || category);
	const currentPage = filtering ? filterPage : page;
	const totalPages = Math.ceil(filtered.length / CONTENT_PAGE_SIZE);
	const visible = filtered.slice(
		(currentPage - 1) * CONTENT_PAGE_SIZE,
		currentPage * CONTENT_PAGE_SIZE,
	);
	const singleEffect = effects.length === 1 ? effects[0] : undefined;
	if (!effects.length)
		return (
			<section className="effects-directory effects-empty">
				<h2>{t("emptyTitle")}</h2>
				<p>{t("emptyDescription")}</p>
				<div className="effect-actions">
					<Link className="effect-button" href="/image-to-image">
						{t("openEditor")}
					</Link>
					<Link className="effect-text-link" href="/blog">
						{t("readGuides")} <span aria-hidden="true">↗</span>
					</Link>
				</div>
			</section>
		);
	if (singleEffect)
		return (
			<div className="effects-directory is-single">
				<EffectCard effect={singleEffect} featured />
				{singleEffect.presets.length > 1 && (
					<section className="effects-preset-shortcuts" aria-labelledby="directory-presets">
						<h3 id="directory-presets">{t("choosePreset")}</h3>
						<div className="effects-preset-links">
							{singleEffect.presets.map((preset) => {
								const example = singleEffect.examples.find(
									(item) =>
										preset.exampleIds.includes(item.id) &&
										item.presetId === preset.id &&
										item.presetVersion === preset.version,
								);
								return (
									<Link
										key={preset.id}
										href={`${effectPath(singleEffect, preset.id)}&from=effects-directory#image-editor`}
									>
										{example && (
											<Image
												src={example.output.src}
												alt={example.output.alt}
												width={example.output.width}
												height={example.output.height}
												sizes="76px"
											/>
										)}
										<span>{preset.name}</span>
										<span aria-hidden="true">↗</span>
									</Link>
								);
							})}
						</div>
					</section>
				)}
			</div>
		);
	return (
		<div className="effects-directory">
			<div className="effects-filters">
				<label className="effects-search">
					<SearchIcon size={18} aria-hidden="true" />
					<span className="sr-only">{t("search")}</span>
					<input
						type="search"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setFilterPage(1);
						}}
						placeholder={t("search")}
					/>
				</label>
				{categories.length > 1 && (
					<label>
						<span className="sr-only">{t("category")}</span>
						<select
							value={category}
							onChange={(event) => {
								setCategory(event.target.value);
								setFilterPage(1);
							}}
						>
							<option value="">{t("allCategories")}</option>
							{categories.map((id) => (
								<option key={id} value={id}>
									{t(`categories.${id}`)}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
			<output className="effects-count" aria-live="polite">
				{t("count", { count: filtered.length })}
			</output>
			{visible.length ? (
				<div className="effects-grid">
					{visible.map((effect) => (
						<EffectCard key={effect.id} effect={effect} />
					))}
				</div>
			) : (
				<div className="effects-empty">
					<h2>{t("noResults")}</h2>
					<button
						className="effect-button"
						type="button"
						onClick={() => {
							setSearch("");
							setCategory("");
							setFilterPage(1);
						}}
					>
						{t("clearFilters")}
					</button>
				</div>
			)}
			{totalPages > 1 && (
				<nav className="effects-pagination" aria-label={t("pagination")}>
					{Array.from({ length: totalPages }, (_, index) => index + 1).map((number) =>
						filtering ? (
							<button
								type="button"
								key={number}
								aria-current={number === currentPage ? "page" : undefined}
								onClick={() => setFilterPage(number)}
							>
								{number}
							</button>
						) : (
							<Link
								key={number}
								href={contentPagePath("/effects", number)}
								aria-current={number === currentPage ? "page" : undefined}
							>
								{number}
							</Link>
						),
					)}
				</nav>
			)}
		</div>
	);
}
