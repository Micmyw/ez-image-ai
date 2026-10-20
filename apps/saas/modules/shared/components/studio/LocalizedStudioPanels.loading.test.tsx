import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioPanelResource } from "./studio-panel-resources";
import type { StudioPanelProps } from "./StudioPanels";

const hooks = vi.hoisted(() => ({
	cursor: 0,
	values: [] as unknown[],
	effect: undefined as (() => void | (() => void)) | undefined,
	locale: "en",
	load: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useEffect: (effect: () => void | (() => void)) => {
		hooks.effect = effect;
	},
	useState: <T,>(initial: T) => {
		const index = hooks.cursor++;
		if (!(index in hooks.values)) hooks.values[index] = initial;
		return [
			hooks.values[index] as T,
			(next: T | ((current: T) => T)) => {
				hooks.values[index] =
					typeof next === "function" ? (next as (current: T) => T)(hooks.values[index] as T) : next;
			},
		] as const;
	},
}));
vi.mock("next-intl", () => ({
	useLocale: () => hooks.locale,
	useMessages: () => ({}),
	useTranslations: () => (key: string) => key,
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
		<button onClick={onClick}>{children}</button>
	),
}));
vi.mock("./StudioPanels", () => ({
	StudioPanels: ({ panel }: StudioPanelProps) => <div>Ready: {panel.kind}</div>,
}));
vi.mock("./studio-panel-resources", () => ({
	studioPanelResourceKind: ({ kind, jobId }: StudioPanelProps["panel"]) =>
		kind === "history" && jobId ? "history-detail" : kind,
	studioPanelResources: {
		read: () => undefined,
		load: hooks.load,
	},
}));

import messages from "@repo/i18n/translations/en/studio.json";

import { LocalizedStudioPanels } from "./LocalizedStudioPanels";

const loaded: StudioPanelResource = { component: () => null, messages };
const props: StudioPanelProps = {
	panel: { kind: "assets" },
	onChange: vi.fn(),
	onClose: vi.fn(),
};

function render(panel = props.panel) {
	hooks.cursor = 0;
	return LocalizedStudioPanels({ ...props, panel });
}

describe("studio panel loading lifecycle", () => {
	beforeEach(() => {
		hooks.cursor = 0;
		hooks.values = [];
		hooks.effect = undefined;
		hooks.locale = "en";
		hooks.load.mockReset();
	});

	it("offers a working retry after a resource request fails", async () => {
		hooks.load
			.mockRejectedValueOnce(new Error("Network unavailable"))
			.mockResolvedValueOnce(loaded);
		expect(renderToStaticMarkup(render())).toContain("loading");
		hooks.effect?.();
		await Promise.resolve();
		const failed = render();
		expect(renderToStaticMarkup(failed)).toContain('role="alert"');
		const children = (failed.props as { children: ReactElement[] }).children;
		(children[1]!.props as { onClick: () => void }).onClick();
		expect(renderToStaticMarkup(render())).toContain("loading");
		hooks.effect?.();
		await Promise.resolve();
		expect(renderToStaticMarkup(render())).toContain("Ready: assets");
		expect(hooks.load).toHaveBeenCalledTimes(2);
	});

	it("never replaces a newly selected panel with a slower previous response", async () => {
		const old = Promise.withResolvers<StudioPanelResource>();
		const next = Promise.withResolvers<StudioPanelResource>();
		hooks.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		render({ kind: "assets" });
		const cleanup = hooks.effect?.();
		if (typeof cleanup === "function") cleanup();
		expect(renderToStaticMarkup(render({ kind: "security" }))).toContain("loading");
		hooks.effect?.();
		old.resolve(loaded);
		await Promise.resolve();
		expect(renderToStaticMarkup(render({ kind: "security" }))).not.toContain("Ready:");
		next.resolve(loaded);
		await Promise.resolve();
		expect(renderToStaticMarkup(render({ kind: "security" }))).toContain("Ready: security");
	});

	it("waits for the selected locale instead of reusing the previous language", async () => {
		const french = Promise.withResolvers<StudioPanelResource>();
		hooks.load.mockResolvedValueOnce(loaded).mockReturnValueOnce(french.promise);
		render();
		const cleanup = hooks.effect?.();
		await Promise.resolve();
		expect(renderToStaticMarkup(render())).toContain("Ready: assets");
		if (typeof cleanup === "function") cleanup();
		hooks.locale = "fr";
		expect(renderToStaticMarkup(render())).toContain("loading");
		hooks.effect?.();
		expect(hooks.load).toHaveBeenLastCalledWith("assets", "fr");
		french.resolve(loaded);
		await Promise.resolve();
		expect(renderToStaticMarkup(render())).toContain("Ready: assets");
	});

	it("does not restore a closed panel when its resources finish downloading", async () => {
		const pending = Promise.withResolvers<StudioPanelResource>();
		hooks.load.mockReturnValue(pending.promise);
		render();
		const cleanup = hooks.effect?.();
		if (typeof cleanup === "function") cleanup();
		pending.resolve(loaded);
		await Promise.resolve();
		expect(hooks.values[1]).toBeNull();
	});
});
