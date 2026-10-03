import {
	createBrowserGrowthAnalyticsDispatcher,
	createGrowthAnalyticsDispatcher,
	createGrowthContentAttributionStore,
	EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS,
	EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY,
	growthAnalyticsEventSchema,
	hashGrowthTaskIdentity,
	snapshotGrowthContentAttribution,
	type GrowthAnalyticsEvent,
} from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

import { createBlogAnalyticsContext, createEffectAnalyticsContext } from "./analytics";

const published = {
	id: "1980s-ai-photo",
	slug: "1980s-ai-photo",
	status: "published" as const,
	presets: [
		{ id: "studio-portrait", version: 1 },
		{ id: "family-snapshot", version: 2 },
	],
};
const sessionHash = `sha256:${"a".repeat(64)}`;
const taskHash = `sha256:${"b".repeat(64)}`;
const context = createEffectAnalyticsContext(published, "studio-portrait")!;

function harness() {
	let consent = true;
	let now = 1_000;
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => {
			values.set(key, value);
		}),
		removeItem: vi.fn((key: string) => {
			values.delete(key);
		}),
	};
	const makeStore = () =>
		createGrowthContentAttributionStore({ hasConsent: () => consent, now: () => now, storage });
	const store = makeStore();
	const events: GrowthAnalyticsEvent[] = [];
	const makeDispatcher = (attribution = store) =>
		createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => (consent ? "consent=true" : "consent=false"),
			resolveAnonymousSessionHash: async () => sessionHash,
			hashTask: async () => taskHash,
			attribution,
			dispatch: (_name, event) => {
				events.push(event);
			},
		});
	return {
		store,
		makeStore,
		storage,
		values,
		events,
		makeDispatcher,
		setConsent: (value: boolean) => {
			consent = value;
		},
		advance: (value: number) => {
			now += value;
		},
	};
}

describe("published content analytics association", () => {
	it("uses registered preset versions and only related, published blog IDs", () => {
		expect(
			createEffectAnalyticsContext(published, "family-snapshot", {
				sourceBlogId: "ai-image-editing-prompts",
				allowedSourceBlogIds: ["ai-image-editing-prompts"],
			}),
		).toEqual({
			effect_id: published.id,
			preset_id: "family-snapshot",
			preset_version: 2,
			source_blog_id: "ai-image-editing-prompts",
			internal_source: "blog",
			entry_path: "/effects/1980s-ai-photo",
		});
		expect(
			createEffectAnalyticsContext(published, "studio-portrait", {
				sourceBlogId: "private-image-editing-workflow",
				allowedSourceBlogIds: ["ai-image-editing-prompts"],
				internalSource: "blog",
			}),
		).toEqual(context);
		expect(createEffectAnalyticsContext(published, "not-a-registered-preset")).toBeUndefined();
	});

	it("excludes draft, preview and unbounded URL content", () => {
		expect(
			createEffectAnalyticsContext({ ...published, status: "draft" }, "studio-portrait"),
		).toBeUndefined();
		expect(
			createEffectAnalyticsContext(published, "studio-portrait", { preview: true }),
		).toBeUndefined();
		expect(
			createEffectAnalyticsContext(
				{ ...published, slug: "1980s-ai-photo?prompt=private" },
				"studio-portrait",
			),
		).toBeUndefined();
		expect(
			createBlogAnalyticsContext({ id: "draft", slug: "draft", published: false }),
		).toBeUndefined();
		expect(
			createBlogAnalyticsContext({ id: "guide", slug: "guide?token=secret", published: true }),
		).toBeUndefined();
	});

	it("keeps existing multi-segment article paths canonical", () => {
		expect(
			createBlogAnalyticsContext({ id: "guide", slug: "prompt-guides/guide", published: true }),
		).toEqual({
			source_blog_id: "guide",
			internal_source: "blog",
			entry_path: "/blog/prompt-guides/guide",
		});
	});

	it.each([
		{ prompt: "private user prompt" },
		{ assetUrl: "https://private.example/image?signature=secret" },
		{ jobId: "raw-job-id" },
		{ task_hash: "raw-job-id" },
		{ entry_path: "/effects/1980s-ai-photo?prompt=private" },
		{ effect_id: "https://example.com" },
		{ preset_id: undefined },
		{ preset_version: undefined },
	])("rejects private or incomplete analytics properties %j", (properties) => {
		expect(
			growthAnalyticsEventSchema.safeParse({
				name: "prompt_copied",
				properties: { ...context, ...properties },
			}).success,
		).toBe(false);
	});
});

describe("consent-aware tab attribution", () => {
	it("never persists without consent and clears persisted context on withdrawal", () => {
		const app = harness();
		app.setConsent(false);
		expect(app.store.set(context)).toBe(false);
		expect(app.storage.setItem).not.toHaveBeenCalled();
		app.setConsent(true);
		expect(app.store.set(context)).toBe(true);
		app.setConsent(false);
		expect(app.store.read()).toBeUndefined();
		expect(app.values.size).toBe(0);
	});

	it("replaces the previous effect scope, drops unrelated blog IDs, and expires", () => {
		const app = harness();
		app.store.set({
			...context,
			source_blog_id: "ai-image-editing-prompts",
			internal_source: "blog",
		});
		const next = createEffectAnalyticsContext(
			{ ...published, id: "second-effect", slug: "second-effect" },
			"family-snapshot",
		)!;
		app.store.set(next);
		expect(app.store.read()).toEqual(next);
		expect(app.makeStore().read()).toEqual(next);
		app.advance(EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS + 1);
		expect(app.store.read()).toBeUndefined();
		expect(app.values.size).toBe(0);
	});

	it("ends generic editor attribution while keeping the original pending task association", () => {
		const app = harness();
		app.store.set(context);
		app.store.bindTask(taskHash, context);
		app.store.clearContext();
		expect(app.store.read()).toBeUndefined();
		expect(app.store.readTask(taskHash)?.context).toEqual(context);
	});

	it("rejects tampered storage instead of forwarding URLs or unbounded retention", () => {
		const app = harness();
		app.values.set(
			EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY,
			JSON.stringify({
				context: { ...context, prompt: "private prompt" },
				expiresAt: 9_000,
				tasks: [],
			}),
		);
		expect(app.store.read()).toBeUndefined();
		app.values.set(
			EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY,
			JSON.stringify({ context, expiresAt: 9_999_999_999, tasks: [] }),
		);
		expect(app.makeStore().read()).toBeUndefined();
		expect(app.values.size).toBe(0);
	});

	it("enriches existing upload/auth/checkout events without another page view", async () => {
		const app = harness();
		app.store.set(context);
		const dispatcher = app.makeDispatcher();
		for (const name of [
			"source_upload_started",
			"source_upload_completed",
			"auth_handoff_started",
			"checkout_started",
		] as const)
			await dispatcher.track({ name, properties: { status: "started" } });
		expect(app.events).toHaveLength(4);
		for (const event of app.events)
			expect(event.properties).toMatchObject({ ...context, anonymousSessionHash: sessionHash });
		expect(app.events.some((event) => event.name.endsWith("viewed"))).toBe(false);
	});

	it("preserves explicit copied-card attribution without switching the active preset", async () => {
		const app = harness();
		app.store.set(context);
		const copied = createEffectAnalyticsContext(published, "family-snapshot")!;
		await app
			.makeDispatcher()
			.track({ name: "prompt_copied", properties: { ...copied, status: "copied" } });
		expect(app.events[0]?.properties.preset_id).toBe("family-snapshot");
		expect(app.store.read()?.preset_id).toBe("studio-portrait");
	});

	it("does not emit or persist after consent is revoked during asynchronous identity resolution", async () => {
		const app = harness();
		app.store.set(context);
		const dispatcher = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => (app.store.read() ? "consent=true" : "consent=false"),
			attribution: app.store,
			resolveAnonymousSessionHash: async () => {
				app.setConsent(false);
				return sessionHash;
			},
			dispatch: vi.fn(),
		});
		expect(await dispatcher.track({ name: "source_upload_started" })).toBe("blocked");
		expect(app.values.size).toBe(0);
	});

	it("suppresses reused editor events on protected preview", async () => {
		const dispatch = vi.fn();
		const dispatcher = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => "consent=true",
			isSuppressed: () => true,
			dispatch,
		});
		expect(await dispatcher.track({ name: "source_upload_started" })).toBe("blocked");
		expect(dispatch).not.toHaveBeenCalled();
	});
});

describe("private task association and deduplication", () => {
	it.each(["editor_generation_confirmed", "guest_generation_admitted"] as const)(
		"binds %s to the request-start snapshot after navigation changes the active content",
		async (name) => {
			const app = harness();
			app.store.set(context);
			const attribution = snapshotGrowthContentAttribution(app.store.read(), true);
			app.store.clearContext();
			app.store.set(
				createEffectAnalyticsContext(
					{ ...published, id: "second-effect", slug: "second-effect" },
					"family-snapshot",
				),
			);
			const dispatcher = app.makeDispatcher();
			await dispatcher.track(
				{ name },
				{
					dedupeKey:
						name === "editor_generation_confirmed"
							? "editor-generation-confirmed:quote"
							: "guest-generation-admitted:job",
					taskKey: "job",
					attribution,
				},
			);
			await dispatcher.track(
				{
					name:
						name === "editor_generation_confirmed"
							? "editor_generation_succeeded"
							: "guest_result_ready",
				},
				{
					dedupeKey:
						name === "editor_generation_confirmed"
							? "editor-generation-succeeded:job"
							: "guest-result-ready:job",
				},
			);
			for (const event of app.events)
				expect(event.properties).toMatchObject({ ...context, task_hash: taskHash });
			expect(app.store.read()?.effect_id).toBe("second-effect");
		},
	);

	it("keeps an unattributed request unattributed when an effect is selected before its response", async () => {
		const app = harness();
		const attribution = snapshotGrowthContentAttribution(undefined, true);
		app.store.set(context);
		await app.makeDispatcher().track(
			{ name: "editor_generation_confirmed" },
			{
				dedupeKey: "editor-generation-confirmed:generic-quote",
				taskKey: "generic-job",
				attribution,
			},
		);
		expect(app.events[0]?.properties.effect_id).toBeUndefined();
		expect(app.store.readTask(taskHash)).toBeUndefined();
	});

	it("does not revive a request started without consent or in preview after later navigation", async () => {
		const app = harness();
		app.store.set(context);
		const attribution = snapshotGrowthContentAttribution(context, false);
		expect(
			await app
				.makeDispatcher()
				.track(
					{ name: "guest_generation_admitted" },
					{ dedupeKey: "guest-generation-admitted:job", attribution },
				),
		).toBe("blocked");
		expect(app.events).toHaveLength(0);
		expect(attribution.context).toBeNull();
	});

	it("expires an in-flight snapshot instead of attributing it to the new active effect", async () => {
		const app = harness();
		app.store.set(context);
		const attribution = snapshotGrowthContentAttribution(
			context,
			true,
			Date.now() - EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS - 1,
		);
		expect(
			await app
				.makeDispatcher()
				.track(
					{ name: "guest_generation_admitted" },
					{ dedupeKey: "guest-generation-admitted:job", attribution },
				),
		).toBe("blocked");
		expect(app.events).toHaveLength(0);
	});

	it("associates confirmation and completion with the submitted preset even after switching effects", async () => {
		const app = harness();
		app.store.set(context);
		const dispatcher = app.makeDispatcher();
		await dispatcher.track(
			{ name: "editor_generation_confirmed", properties: { status: "confirmed" } },
			{ dedupeKey: "editor-generation-confirmed:raw-quote", taskKey: "raw-job" },
		);
		app.store.set(
			createEffectAnalyticsContext(
				{ ...published, id: "second-effect", slug: "second-effect" },
				"family-snapshot",
			),
		);
		await dispatcher.track(
			{ name: "editor_generation_succeeded", properties: { status: "succeeded" } },
			{ dedupeKey: "editor-generation-succeeded:raw-job" },
		);
		for (const event of app.events)
			expect(event.properties).toMatchObject({ ...context, task_hash: taskHash });
		expect(JSON.stringify([...app.values.values(), app.events])).not.toMatch(/raw-job|raw-quote/);
	});

	it("deduplicates a completed task after tab refresh and prevents unrelated terminal attribution", async () => {
		const app = harness();
		app.store.set(context);
		const dispatcher = app.makeDispatcher();
		await dispatcher.track(
			{ name: "guest_generation_admitted" },
			{ dedupeKey: "guest-generation-admitted:raw-job" },
		);
		await dispatcher.track(
			{ name: "guest_result_ready" },
			{ dedupeKey: "guest-result-ready:raw-job" },
		);
		const restored = app.makeDispatcher(app.makeStore());
		expect(
			await restored.track(
				{ name: "guest_result_ready" },
				{ dedupeKey: "guest-result-ready:raw-job" },
			),
		).toBe("duplicate");
		expect(app.events).toHaveLength(2);
		const another = harness();
		another.store.set(context);
		await another
			.makeDispatcher()
			.track(
				{ name: "editor_generation_succeeded" },
				{ dedupeKey: "editor-generation-succeeded:old-job" },
			);
		expect(another.events[0]?.properties.effect_id).toBeUndefined();
	});

	it("hashes with a session-specific namespace and never exposes a raw task ID", async () => {
		const first = await hashGrowthTaskIdentity(sessionHash, "raw-private-job");
		expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(first).not.toContain("raw-private-job");
		expect(await hashGrowthTaskIdentity(sessionHash, "raw-private-job")).toBe(first);
		expect(await hashGrowthTaskIdentity(`sha256:${"c".repeat(64)}`, "raw-private-job")).not.toBe(
			first,
		);
	});

	it("deduplicates concurrent attempts while allowing a failed delivery to retry", async () => {
		let release: (() => void) | undefined;
		const send = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const dispatcher = createGrowthAnalyticsDispatcher({ hasConsent: () => true, send });
		const first = dispatcher.track(
			{ name: "effect_viewed", properties: context },
			{ dedupeKey: "effect" },
		);
		expect(
			await dispatcher.track(
				{ name: "effect_viewed", properties: context },
				{ dedupeKey: "effect" },
			),
		).toBe("duplicate");
		release?.();
		expect(await first).toBe("sent");
		expect(send).toHaveBeenCalledTimes(1);
		const retrySend = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(undefined);
		const retry = createGrowthAnalyticsDispatcher({ hasConsent: () => true, send: retrySend });
		expect(
			await retry.track({ name: "effect_viewed", properties: context }, { dedupeKey: "effect" }),
		).toBe("failed");
		expect(
			await retry.track({ name: "effect_viewed", properties: context }, { dedupeKey: "effect" }),
		).toBe("sent");
	});
});
