import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/", search: "", suspend: false }));
vi.mock("next/navigation", () => ({
	usePathname: () => route.pathname,
	useSearchParams: () => {
		if (route.suspend) throw new Promise(() => {});
		return new URLSearchParams(route.search);
	},
}));

import { StudioSignInLink } from "./StudioSignInLink";

const render = () =>
	renderToStaticMarkup(
		<main>
			Page content<StudioSignInLink className="signin">Sign in</StudioSignInLink>
		</main>,
	);

describe("shared effect sign-in link", () => {
	beforeEach(() => Object.assign(route, { pathname: "/", search: "", suspend: false }));
	it("does not suspend an ordinary public page to read query state", () => {
		route.suspend = true;
		expect(render()).toBe('<main>Page content<a class="signin" href="/login">Sign in</a></main>');
	});
	it("updates the return mode when the route query changes", () => {
		route.pathname = "/blog/raindance-ai-trend";
		route.search = "mode=duo";
		expect(render()).toContain("%3Fmode%3Dduo");
		route.search = "mode=solo";
		expect(render()).toContain("%3Fmode%3Dsolo");
	});
	it("keeps the template destination and page content in the prerender fallback", () => {
		route.pathname = "/video-effects/hotel-lobby-ai";
		route.suspend = true;
		const html = render();
		expect(html).toContain("Page content");
		expect(html).toContain('href="/login?redirectTo=%2Fvideo-effects%2Fhotel-lobby-ai"');
	});
});
