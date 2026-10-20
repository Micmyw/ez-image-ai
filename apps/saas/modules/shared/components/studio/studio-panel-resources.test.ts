import messages from "@repo/i18n/translations/en/studio.json";
import { describe, expect, it, vi } from "vitest";

import {
	createStudioPanelResourceLoader,
	studioPanelResourceKind,
	type StudioPanelMessages,
} from "./studio-panel-resources";

function setup() {
	const component = () => null;
	const components = {
		general: vi.fn(async () => component),
		security: vi.fn(async () => component),
		notifications: vi.fn(async () => component),
		billing: vi.fn(async () => component),
		history: vi.fn(async () => component),
		"history-detail": vi.fn(async () => component),
		assets: vi.fn(async () => component),
	};
	const translations = {
		de: vi.fn(async () => messages),
		en: vi.fn(async () => messages),
		es: vi.fn(async () => messages),
		fr: vi.fn(async () => messages),
	};
	return {
		component,
		components,
		translations,
		loader: createStudioPanelResourceLoader(components, translations),
	};
}

describe("studio panel static resources", () => {
	it("does not start imports when the shell is mounted or a cache is inspected", () => {
		const { loader, components, translations } = setup();
		expect(loader.read("assets", "en")).toBeUndefined();
		for (const load of [...Object.values(components), ...Object.values(translations)])
			expect(load).not.toHaveBeenCalled();
	});

	it("starts only the selected view and locale together and waits for both", async () => {
		const { loader, component, components, translations } = setup();
		const code = Promise.withResolvers<typeof component>();
		const copy = Promise.withResolvers<StudioPanelMessages>();
		components.assets.mockReturnValue(code.promise);
		translations.fr.mockReturnValue(copy.promise);
		const pending = loader.load("assets", "fr");
		expect(components.assets).toHaveBeenCalledOnce();
		expect(translations.fr).toHaveBeenCalledOnce();
		for (const [name, load] of Object.entries(components)) {
			if (name !== "assets") expect(load).not.toHaveBeenCalled();
		}
		for (const [name, load] of Object.entries(translations)) {
			if (name !== "fr") expect(load).not.toHaveBeenCalled();
		}
		copy.resolve(messages);
		await Promise.resolve();
		expect(loader.read("assets", "fr")).toBeUndefined();
		code.resolve(component);
		expect(await pending).toEqual({ component, messages });
		expect(loader.read("assets", "fr")).toEqual({ component, messages });
	});

	it("deduplicates pointer, focus and open requests without mounting the view", async () => {
		const { loader, components, translations } = setup();
		const mounted = vi.fn(() => null);
		components.assets.mockResolvedValue(mounted);
		const first = loader.load("assets", "en");
		const second = loader.load("assets", "en");
		expect(second).toBe(first);
		await first;
		await loader.load("history", "en");
		expect(components.assets).toHaveBeenCalledOnce();
		expect(components.history).toHaveBeenCalledOnce();
		expect(translations.en).toHaveBeenCalledOnce();
		expect(mounted).not.toHaveBeenCalled();
	});

	it("retries a failed code import without discarding already downloaded translations", async () => {
		const { loader, components, translations } = setup();
		components.assets.mockRejectedValueOnce(new Error("Chunk unavailable"));
		await expect(loader.load("assets", "de")).rejects.toThrow("Chunk unavailable");
		expect(loader.read("assets", "de")).toBeUndefined();
		await expect(loader.load("assets", "de")).resolves.toMatchObject({ messages });
		expect(components.assets).toHaveBeenCalledTimes(2);
		expect(translations.de).toHaveBeenCalledOnce();
	});

	it("retries a failed translation import without reloading successful code", async () => {
		const { loader, components, translations } = setup();
		translations.es.mockRejectedValueOnce(new Error("Copy unavailable"));
		await expect(loader.load("security", "es")).rejects.toThrow("Copy unavailable");
		await expect(loader.load("security", "es")).resolves.toMatchObject({ messages });
		expect(components.security).toHaveBeenCalledOnce();
		expect(translations.es).toHaveBeenCalledTimes(2);
	});

	it("loads result editing separately from history and never uses job ids as cache keys", async () => {
		const { loader, components } = setup();
		const list = studioPanelResourceKind({ kind: "history" });
		const first = studioPanelResourceKind({ kind: "history", jobId: "job-A" });
		const second = studioPanelResourceKind({ kind: "history", jobId: "job-B" });
		await loader.load(list, "en");
		expect(components["history-detail"]).not.toHaveBeenCalled();
		expect(first).toBe("history-detail");
		expect(second).toBe(first);
		await loader.load(first, "en");
		await loader.load(second, "en");
		expect(components["history-detail"]).toHaveBeenCalledOnce();
	});

	it("uses English for an unsupported locale and keeps language caches separate", async () => {
		const { loader, components, translations } = setup();
		await loader.load("notifications", "unknown");
		await loader.load("notifications", "en");
		await loader.load("notifications", "fr");
		expect(translations.en).toHaveBeenCalledOnce();
		expect(translations.fr).toHaveBeenCalledOnce();
		expect(components.notifications).toHaveBeenCalledOnce();
	});
});
