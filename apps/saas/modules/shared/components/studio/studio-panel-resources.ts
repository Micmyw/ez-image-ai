"use client";

import { isLocale, type Locale } from "@repo/i18n/config";
import type { ComponentType } from "react";

import type { StudioPanel } from "./studio-context";
import type { StudioPanelProps } from "./StudioPanels";

type PanelComponent = ComponentType<StudioPanelProps>;
export type StudioPanelMessages = typeof import("@repo/i18n/translations/en/studio.json");
export type StudioPanelResourceKind = StudioPanel["kind"] | "history-detail";
export interface StudioPanelResource {
	component: PanelComponent;
	messages: StudioPanelMessages;
}

type ComponentLoaders = Record<StudioPanelResourceKind, () => Promise<PanelComponent>>;
type MessageLoaders = Record<Locale, () => Promise<StudioPanelMessages>>;

export function studioPanelResourceKind(panel: StudioPanel): StudioPanelResourceKind {
	return panel.kind === "history" && panel.jobId ? "history-detail" : panel.kind;
}

function cachedImport<Key, Value>(
	cache: Map<Key, Promise<Value>>,
	key: Key,
	load: () => Promise<Value>,
) {
	const previous = cache.get(key);
	if (previous) return previous;
	const pending = load().catch((error: unknown) => {
		cache.delete(key);
		throw error;
	});
	cache.set(key, pending);
	return pending;
}

/** Caches only static code and translations. Account data and panel props never enter this cache. */
export function createStudioPanelResourceLoader(
	components: ComponentLoaders,
	messages: MessageLoaders,
) {
	const componentCache = new Map<StudioPanelResourceKind, Promise<PanelComponent>>();
	const messageCache = new Map<Locale, Promise<StudioPanelMessages>>();
	const resources = new Map<
		string,
		{ pending: Promise<StudioPanelResource>; value?: StudioPanelResource }
	>();
	const keyFor = (kind: StudioPanelResourceKind, locale: string) =>
		`${isLocale(locale) ? locale : "en"}:${kind}`;

	return {
		read(kind: StudioPanelResourceKind, locale: string) {
			return resources.get(keyFor(kind, locale))?.value;
		},
		load(kind: StudioPanelResourceKind, locale: string) {
			const selectedLocale = isLocale(locale) ? locale : "en";
			const key = keyFor(kind, selectedLocale);
			const previous = resources.get(key);
			if (previous) return previous.pending;
			// Begin both independent requests together, before waiting for either one.
			const pending = Promise.all([
				cachedImport(componentCache, kind, components[kind]),
				cachedImport(messageCache, selectedLocale, messages[selectedLocale]),
			])
				.then(([component, copy]) => {
					const value = { component, messages: copy };
					const entry = resources.get(key);
					if (entry) entry.value = value;
					return value;
				})
				.catch((error: unknown) => {
					resources.delete(key);
					throw error;
				});
			resources.set(key, { pending });
			return pending;
		},
	};
}

export const studioPanelResources = createStudioPanelResourceLoader(
	{
		general: () => import("./panels/GeneralPanel").then((module) => module.GeneralPanel),
		security: () => import("./panels/SecurityPanel").then((module) => module.SecurityPanel),
		notifications: () =>
			import("./panels/NotificationsPanel").then((module) => module.NotificationsPanel),
		billing: () => import("./panels/BillingPanel").then((module) => module.BillingPanel),
		history: () => import("./panels/HistoryPanel").then((module) => module.HistoryPanel),
		"history-detail": () =>
			import("./panels/HistoryDetailPanel").then((module) => module.HistoryDetailPanel),
		assets: () => import("./panels/AssetsPanel").then((module) => module.AssetsPanel),
	},
	{
		de: () => import("@repo/i18n/translations/de/studio.json").then((module) => module.default),
		en: () => import("@repo/i18n/translations/en/studio.json").then((module) => module.default),
		es: () => import("@repo/i18n/translations/es/studio.json").then((module) => module.default),
		fr: () => import("@repo/i18n/translations/fr/studio.json").then((module) => module.default),
	},
);

/** Intent preloading imports static assets without mounting a view or calling its private queries. */
export function preloadStudioPanel(panel: StudioPanel, locale: string) {
	void studioPanelResources.load(studioPanelResourceKind(panel), locale).catch(() => {
		// A visible open retries a failed preload and exposes its own retry control.
	});
}
