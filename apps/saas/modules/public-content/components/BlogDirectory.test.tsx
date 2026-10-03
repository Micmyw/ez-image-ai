import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[] }));
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useState: <T,>(initial: T) => {
			const index = runtime.cursor++;
			if (!(index in runtime.states)) runtime.states[index] = initial;
			return [
				runtime.states[index] as T,
				(next: T) => {
					runtime.states[index] = next;
				},
			] as const;
		},
	};
});
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: { page?: number }) =>
		values?.page ? `Page ${values.page}` : key,
}));
vi.mock("next/link", () => ({
	default: ({ children, ...props }: { children: ReactNode; href: string }) => (
		<a {...props}>{children}</a>
	),
}));

import type { BlogCardContent } from "../lib/blog-types";
import { BlogCard } from "./BlogCard";
import { BlogDirectory } from "./BlogDirectory";

const posts: BlogCardContent[] = Array.from({ length: 35 }, (_, index) => ({
	id: `guide-${index + 1}`,
	slug: `guide-${index + 1}`,
	title: index < 25 ? `Prompt guide ${index + 1}` : `Privacy guide ${index + 1}`,
	description: "An editing guide.",
	categoryId: index < 25 ? "prompt-writing" : "privacy-workflow",
	tags: [],
	date: "2026-09-29",
	dateLabel: "September 29, 2026",
	readingMinutes: 1,
}));

beforeEach(() => {
	runtime.cursor = 0;
	runtime.states = [];
});

describe("Blog directory pagination", () => {
	it("shows and applies the Photo Ideas filter from the canonical Blog URL", () => {
		const photoIdea = {
			...posts[0]!,
			id: "1980s-ai-photo",
			slug: "1980s-ai-photo",
			categoryId: "photo-ideas" as const,
		};
		const tree = BlogDirectory({
			posts: [photoIdea, posts[1]!],
			page: 1,
			initialCategory: "photo-ideas",
		});
		expect(cardIds(tree)).toEqual([photoIdea.id]);
		expect(findElements(tree, (element) => element.type === "fieldset")).toHaveLength(1);
		click(tree, "guides.allCategories");
		runtime.cursor = 0;
		expect(
			cardIds(
				BlogDirectory({ posts: [photoIdea, posts[1]!], page: 1, initialCategory: "photo-ideas" }),
			),
		).toEqual([photoIdea.id, posts[1]!.id]);
	});
	it("keeps a two-article library compact without search, category controls or count chrome", () => {
		const tree = BlogDirectory({ posts: posts.slice(0, 2), page: 1 });
		expect(cardIds(tree)).toEqual(["guide-1", "guide-2"]);
		expect(
			findElements(
				tree,
				(element) =>
					element.type === "input" || element.type === "fieldset" || element.type === "output",
			),
		).toEqual([]);
		expect(paginationLinks(tree)).toEqual([]);
	});

	it("server-renders the URL page with at most twelve cards and crawlable adjacent links", () => {
		const tree = renderDirectory();
		expect(cardIds(tree)).toEqual(posts.slice(12, 24).map((post) => post.id));
		const markup = renderToStaticMarkup(tree);
		expect(markup).toContain('href="/blog"');
		expect(markup).toContain('href="/blog?page=3"');
		expect(markup).toContain('rel="prev"');
		expect(markup).toContain('rel="next"');
	});

	it("paginates all search matches locally and restores the URL page when search is cleared", () => {
		let tree = renderDirectory();
		search(tree, "prompt");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(posts.slice(0, 12).map((post) => post.id));
		expect(paginationLinks(tree)).toHaveLength(0);
		click(tree, "Page 2");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(posts.slice(12, 24).map((post) => post.id));
		click(tree, "Page 3");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(["guide-25"]);
		search(tree, "");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(posts.slice(12, 24).map((post) => post.id));
		expect(paginationLinks(tree).length).toBeGreaterThan(0);
	});

	it("resets filtered pages on category or search changes and clears all filters safely", () => {
		let tree = renderDirectory();
		click(tree, "guides.categories.prompt-writing");
		tree = renderDirectory();
		click(tree, "Page 3");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(["guide-25"]);
		click(tree, "guides.categories.privacy-workflow");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(posts.slice(25).map((post) => post.id));
		click(tree, "guides.categories.prompt-writing");
		tree = renderDirectory();
		click(tree, "Page 3");
		tree = renderDirectory();
		search(tree, "guide 1");
		tree = renderDirectory();
		expect(cardIds(tree)).toHaveLength(11);
		search(tree, "unmatched");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual([]);
		click(tree, "guides.clearFilters");
		tree = renderDirectory();
		expect(cardIds(tree)).toEqual(posts.slice(12, 24).map((post) => post.id));
		expect(paginationLinks(tree).length).toBeGreaterThan(0);
	});
});

function renderDirectory() {
	runtime.cursor = 0;
	return BlogDirectory({ posts, page: 2 });
}

function findElements(
	node: ReactNode,
	predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	return [
		...(predicate(node) ? [node] : []),
		...Children.toArray(node.props.children as ReactNode).flatMap((child) =>
			findElements(child, predicate),
		),
	];
}

function cardIds(tree: ReactNode) {
	return findElements(tree, (element) => element.type === BlogCard).map(
		(element) => (element.props.post as BlogCardContent).id,
	);
}

function paginationLinks(tree: ReactNode) {
	const pagination = findElements(tree, (element) => element.type === "nav")[0];
	return pagination
		? findElements(pagination, (element) => typeof element.props.href === "string")
		: [];
}

function click(tree: ReactNode, label: string) {
	const button = findElements(
		tree,
		(element) => element.type === "button" && element.props.children === label,
	)[0];
	if (!button) throw new Error(`Missing ${label} button`);
	(button.props.onClick as () => void)();
}

function search(tree: ReactNode, value: string) {
	const input = findElements(tree, (element) => element.type === "input")[0];
	if (!input) throw new Error("Missing search input");
	(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
