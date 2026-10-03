"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { CONTENT_PAGE_SIZE, contentPagePath } from "../lib/pagination";
import { BlogCard, type BlogCardData } from "./BlogCard";

export function BlogDirectory({
	posts,
	page,
	initialCategory = "",
	initialQuery = "",
}: {
	posts: readonly BlogCardData[];
	page: number;
	initialCategory?: string;
	initialQuery?: string;
}) {
	const t = useTranslations();
	const [query, setQuery] = useState(initialQuery);
	const [category, setCategory] = useState(initialCategory);
	const [filterPage, setFilterPage] = useState(1);
	const categories = [...new Set(posts.map((post) => post.categoryId))];
	const showDiscoveryControls =
		categories.length > 1 || posts.length > 3 || Boolean(initialCategory || initialQuery);
	const activeSearch = query.trim().toLocaleLowerCase();
	const filtering = Boolean(category || activeSearch);
	const filtered = posts.filter(
		(post) =>
			(!category || post.categoryId === category) &&
			(!activeSearch ||
				[post.title, post.description, ...post.tags]
					.join(" ")
					.toLocaleLowerCase()
					.includes(activeSearch)),
	);
	const currentPage = filtering ? filterPage : page;
	const totalPages = Math.ceil(filtered.length / CONTENT_PAGE_SIZE);
	const visible = filtered.slice(
		(currentPage - 1) * CONTENT_PAGE_SIZE,
		currentPage * CONTENT_PAGE_SIZE,
	);
	return (
		<section className="blog-directory">
			{showDiscoveryControls && (
				<div className="blog-filters">
					{categories.length > 1 && (
						<fieldset className="blog-category-filters">
							<legend className="sr-only">{t("guides.categoryLabel")}</legend>
							<button
								type="button"
								aria-pressed={!category}
								onClick={() => {
									setCategory("");
									setFilterPage(1);
								}}
							>
								{t("guides.allCategories")}
							</button>
							{categories.map((id) => (
								<button
									key={id}
									type="button"
									aria-pressed={category === id}
									onClick={() => {
										setCategory(id);
										setFilterPage(1);
									}}
								>
									{t(`guides.categories.${id}`)}
								</button>
							))}
						</fieldset>
					)}
					<label className="blog-search">
						<span className="sr-only">{t("guides.searchLabel")}</span>
						<input
							type="search"
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setFilterPage(1);
							}}
							placeholder={t("guides.searchPlaceholder")}
						/>
					</label>
				</div>
			)}
			{showDiscoveryControls && (
				<output className="blog-results" aria-live="polite">
					{t("guides.resultCount", { count: filtered.length })}
				</output>
			)}
			<div className={`blog-grid${!showDiscoveryControls ? " blog-grid-compact" : ""}`}>
				{visible.map((post) => (
					<BlogCard
						key={post.id}
						post={post}
						category={t(`guides.categories.${post.categoryId}`)}
						readingTime={t("guides.readingTime", { minutes: post.readingMinutes })}
						featured={!showDiscoveryControls && Boolean(post.cover)}
					/>
				))}
			</div>
			{!visible.length && (
				<div className="blog-empty">
					<p>{t("guides.noResults")}</p>
					<button
						type="button"
						onClick={() => {
							setQuery("");
							setCategory("");
							setFilterPage(1);
						}}
					>
						{t("guides.clearFilters")}
					</button>
				</div>
			)}
			{totalPages > 1 && (
				<nav className="blog-pagination" aria-label={t("guides.pagination")}>
					{currentPage > 1 &&
						(filtering ? (
							<button type="button" onClick={() => setFilterPage(currentPage - 1)}>
								{t("guides.previous")}
							</button>
						) : (
							<Link rel="prev" href={contentPagePath("/blog", currentPage - 1)}>
								{t("guides.previous")}
							</Link>
						))}
					{Array.from({ length: totalPages }, (_, index) => index + 1).map((number) =>
						filtering ? (
							<button
								type="button"
								key={number}
								aria-current={number === currentPage ? "page" : undefined}
								onClick={() => setFilterPage(number)}
							>
								{t("guides.pageNumber", { page: number })}
							</button>
						) : number === currentPage ? (
							<span key={number} aria-current="page">
								{t("guides.pageNumber", { page: number })}
							</span>
						) : (
							<Link key={number} href={contentPagePath("/blog", number)}>
								{t("guides.pageNumber", { page: number })}
							</Link>
						),
					)}
					{currentPage < totalPages &&
						(filtering ? (
							<button type="button" onClick={() => setFilterPage(currentPage + 1)}>
								{t("guides.next")}
							</button>
						) : (
							<Link rel="next" href={contentPagePath("/blog", currentPage + 1)}>
								{t("guides.next")}
							</Link>
						))}
				</nav>
			)}
		</section>
	);
}
