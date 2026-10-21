import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	pathname: "/examples",
	cursor: 0,
	states: [] as unknown[],
}));
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
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
	usePathname: () => runtime.pathname,
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			products: [
				{ key: "image-gpt-image-2", skuMatrix: { cells: [{}] } },
				{ key: "image-nano-banana-pro", skuMatrix: { cells: [{}] } },
			],
		},
	}),
}));
vi.mock("@media/components/ImageModelIcon", () => ({ ImageModelIcon: () => null }));
vi.mock("@media/hooks/use-model-navigation", () => ({
	useRequestedImageModel: () => null,
	imageModelHref: (key: string) => `/models/${key.slice("image-".length)}`,
}));
vi.mock("@media/lib/editor-recovery", () => ({
	DEFAULT_EDITOR_PRODUCT_KEY: "image-nano-banana-2-lite",
	isEditorProductKey: () => true,
}));
vi.mock("@media/lib/public-catalog-query", () => ({ publicCatalogQueryOptions: {} }));
vi.mock("@repo/ui/components/popover", () => ({
	Popover: "div",
	PopoverContent: "div",
	PopoverTrigger: "div",
}));
vi.mock("./studio-context", () => ({ resetStudioWorkspace: vi.fn() }));

import { StudioToolNavigation } from "./StudioToolNavigation";

type NavigationLink = ReactElement<{
	href: string;
	prefetch: false | null;
	onMouseEnter?: () => void;
	onFocus?: () => void;
	children?: ReactNode;
}>;

function links() {
	runtime.cursor = 0;
	const found: NavigationLink[] = [];
	function visit(node: ReactNode) {
		Children.forEach(node, (child) => {
			if (!isValidElement<{ children?: ReactNode; href?: string }>(child)) return;
			if (child.props.href) found.push(child as NavigationLink);
			visit(child.props.children);
		});
	}
	visit(StudioToolNavigation({ drawer: true }));
	return found;
}

describe("model navigation intent prefetch", () => {
	beforeEach(() => {
		runtime.pathname = "/examples";
		runtime.states = [];
	});

	it("does not prefetch any destination on initial render", () => {
		expect(links().length).toBeGreaterThan(2);
		expect(links().every((link) => link.props.prefetch === false)).toBe(true);
	});

	it.each(["onMouseEnter", "onFocus"] as const)(
		"prefetches only the intended model shell after %s",
		(event) => {
			const href = "/models/gpt-image-2";
			links().find((link) => link.props.href === href)!.props[event]!();
			const next = links();
			expect(next.find((link) => link.props.href === href)?.props.prefetch).toBeNull();
			expect(
				next
					.filter((link) => link.props.href !== href)
					.every((link) => link.props.prefetch === false),
			).toBe(true);
		},
	);

	it("does not prefetch the current model after intent", () => {
		runtime.pathname = "/models/gpt-image-2";
		links().find((link) => link.props.href === "/models/gpt-image-2")!.props.onFocus!();
		expect(links().every((link) => link.props.prefetch === false)).toBe(true);
	});

	it.each(["onMouseEnter", "onFocus"] as const)(
		"prefetches only the intended model from an ordinary article after %s",
		(event) => {
			runtime.pathname = "/blog/tesco-ai-meal-planning-assistant";
			expect(links().every((link) => link.props.prefetch === false)).toBe(true);
			const href = "/models/gpt-image-2";
			links().find((link) => link.props.href === href)!.props[event]!();
			const next = links();
			expect(next.find((link) => link.props.href === href)?.props.prefetch).toBeNull();
			expect(
				next
					.filter((link) => link.props.href !== href)
					.every((link) => link.props.prefetch === false),
			).toBe(true);
		},
	);
});
