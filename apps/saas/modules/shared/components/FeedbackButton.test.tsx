import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import en from "../../../../../packages/i18n/translations/en/shared.json";

const state = vi.hoisted(() => ({ dialogImported: vi.fn() }));

vi.mock("./FeedbackDialog", async (importOriginal) => {
	state.dialogImported();
	return importOriginal();
});

import { createFeedbackDialogResource, FeedbackButton } from "./FeedbackButton";

it("renders an accessible gift entry without loading its dialog before interaction", () => {
	const markup = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<FeedbackButton supportEmail="help@configured.test" />
		</NextIntlClientProvider>,
	);
	expect(markup).toContain(en.feedback.entry);
	expect(markup).toContain('aria-haspopup="dialog"');
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).not.toContain(en.feedback.title);
	expect(state.dialogImported).not.toHaveBeenCalled();
});

it("shows the reward title and adoption condition without loading the feedback form", () => {
	const rewardTitle = "Feedback rewards";
	const rewardDescription = "Accepted feedback earns 100–1,000 credits";
	const markup = renderToStaticMarkup(
		<NextIntlClientProvider
			locale="en"
			messages={{ feedback: { ...en.feedback, rewardTitle, rewardDescription } }}
			timeZone="UTC"
		>
			<FeedbackButton supportEmail="help@configured.test" variant="reward" />
		</NextIntlClientProvider>,
	);
	expect(markup).toContain(rewardTitle);
	expect(markup).toContain(rewardDescription);
	expect(markup).toContain("feedback-gift");
	expect(markup).not.toContain(en.feedback.title);
	expect(state.dialogImported).not.toHaveBeenCalled();
});

describe("feedback dialog static code resource", () => {
	it("deduplicates hover, focus and open without mounting the form", async () => {
		const component = vi.fn(() => <div>Feedback form</div>);
		const download = Promise.withResolvers<typeof component>();
		const load = vi.fn(() => download.promise);
		const resource = createFeedbackDialogResource(load);
		expect(resource.read()).toBeNull();
		expect(load).not.toHaveBeenCalled();
		const hover = resource.load();
		const focus = resource.load();
		const open = resource.load();
		expect(focus).toBe(hover);
		expect(open).toBe(hover);
		expect(load).toHaveBeenCalledOnce();
		download.resolve(component);
		await hover;
		expect(resource.read()).toBe(component);
		expect(component).not.toHaveBeenCalled();
	});

	it("removes a failed import so an explicit retry can download it again", async () => {
		const component = () => <div>Feedback form</div>;
		const load = vi
			.fn<() => Promise<typeof component>>()
			.mockRejectedValueOnce(new Error("Chunk unavailable"))
			.mockResolvedValueOnce(component);
		const resource = createFeedbackDialogResource(load);
		await expect(resource.load()).rejects.toThrow("Chunk unavailable");
		expect(resource.read()).toBeNull();
		await expect(resource.load()).resolves.toBe(component);
		expect(load).toHaveBeenCalledTimes(2);
		expect(resource.read()).toBe(component);
	});
});
