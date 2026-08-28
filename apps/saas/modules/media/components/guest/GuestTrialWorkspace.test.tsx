import { readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useGuestTrial: vi.fn() }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		const date = typeof values?.date === "string" ? values.date : "";
		const count = typeof values?.count === "number" ? values.count : 0;
		const maximum = typeof values?.maximum === "number" ? values.maximum : 0;
		return (
			{
				sourceReady: "Private source ready",
				sourceHandoff: "Transferred privately for this edit",
				promptLabel: "Edit instruction",
				characterCount: `${count} / ${maximum}`,
				standard: "Standard Edit",
				oneOutput: "One output",
				freeQueue: "Free queue",
				temporary: "Watermarked · available for up to 24 hours",
				temporaryCompact: "Watermarked · temporary",
				resultPlaceholder: "Your watermarked result will appear here.",
				"states.waiting": "Waiting in the free queue",
				"states.preparingSession": "Preparing your private guest session",
				"states.delayed": "This is taking longer than expected",
				"states.ready": "Your watermarked preview is ready",
				"states.failed": "This edit could not be completed",
				viewStatus: "View status",
				viewResult: "View result",
				download: "Download watermarked preview",
				signIn: "Sign in",
				createAccount: "Create account",
				qualityCta: "Quality Edit · Creator or Studio",
				retryPreview: "Retry private preview",
				retryChallenge: "Retry verification",
				resultExpires: `Available until ${date}`,
				trialConsumed: "This trial was consumed.",
				history: "History",
				editAgain: "Edit Again",
				cancel: "Cancel",
			}[key] ?? key
		);
	},
}));
vi.mock("../../hooks/use-guest-trial", () => ({ useGuestTrial: mocks.useGuestTrial }));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		loading: _loading,
		render,
		...props
	}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
		loading?: boolean;
		render?: (props: Record<string, unknown>) => React.ReactNode;
	}) => (render ? render({ ...props, children }) : <button {...props}>{children}</button>),
}));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import { GuestTrialWorkspace } from "./GuestTrialWorkspace";

describe("GuestTrialWorkspace", () => {
	beforeEach(() => {
		mocks.useGuestTrial.mockReturnValue({
			view: {
				state: "waiting",
				jobId: "guest-job-1",
				resultExpiresAt: "2026-08-29T00:00:00.000Z",
			},
			statusLabel: "Waiting in the free queue",
			isSubmitting: false,
			resultUrl: null,
			actions: {
				submit: vi.fn(),
				viewStatus: vi.fn(),
				viewResult: vi.fn(),
				download: vi.fn(),
				beginLink: vi.fn(),
			},
		});
	});

	it("reserves one stable result card and offers explicit status navigation", () => {
		const markup = renderToStaticMarkup(<GuestTrialWorkspace />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(markup).toContain('aria-live="polite"');
		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain("aspect-");
		expect(markup).toContain("View status");
		expect(markup).toContain("sm:grid-cols-2");
		expect(markup).toContain("min-[1200px]:grid-cols-[minmax(20rem,0.9fr)_minmax(0,1.25fr)]");
		expect(markup).not.toContain("lg:grid-cols-");
		expect(visibleText.match(/Waiting in the free queue/g)).toHaveLength(1);
		expect(visibleText).toContain("Your watermarked result will appear here.");
		expect(markup).not.toMatch(/\d+%|queue position|history|edit again|cancel/i);
	});

	it("keeps Quality explanatory and sends its focusable action through fenced account transition", () => {
		const beginLink = vi.fn();
		mocks.useGuestTrial.mockReturnValue({
			view: { state: "preparingSession" },
			draft: { sourceAssetId: "source-1", prompt: "Keep the subject" },
			prompt: "Keep the subject",
			setPrompt: vi.fn(),
			canSubmit: true,
			isSubmitting: false,
			resultUrl: null,
			actions: {
				submit: vi.fn(),
				viewStatus: vi.fn(),
				viewResult: vi.fn(),
				download: vi.fn(),
				beginLink,
			},
		});

		const markup = renderToStaticMarkup(<GuestTrialWorkspace />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		const qualityButton = markup.match(
			/<button[^>]*type="button"[^>]*aria-label="Quality Edit · Creator or Studio"[^>]*>(.*?)<\/button>/s,
		)?.[1];
		expect(qualityButton).toBeDefined();
		expect(qualityButton?.match(/<svg/g)).toHaveLength(2);
		expect(markup).not.toMatch(/href="[^"]*(?:pricing|billing)/i);
		expect(markup).not.toMatch(/type="radio"[^>]*Quality/i);
		expect(markup).toMatch(
			/data-test="guest-standard-selection"[^>]*aria-current="true"[^>]*>.*?<svg/s,
		);
		expect(visibleText).toContain("Quality Edit · Creator or Studio");
		for (const locale of ["en", "de", "es", "fr"]) {
			const messages = JSON.parse(
				readFileSync(
					new URL(
						`../../../../../../packages/i18n/translations/${locale}/saas.json`,
						import.meta.url,
					),
					"utf8",
				),
			) as { media: { guest: Record<string, unknown> } };
			for (const key of ["qualityCta", "retryPreview", "retryChallenge"]) {
				expect(messages.media.guest[key], `${locale}: media.guest.${key}`).toBeDefined();
			}
		}
	});

	it("keeps result retention claims off the private source handoff and localizes the count", () => {
		mocks.useGuestTrial.mockReturnValue({
			view: { state: "preparingSession" },
			draft: { sourceAssetId: "private-source-id", prompt: "Keep the subject" },
			prompt: "Keep the subject",
			setPrompt: vi.fn(),
			canSubmit: true,
			isSubmitting: false,
			resultUrl: null,
			actions: {
				submit: vi.fn(),
				viewStatus: vi.fn(),
				viewResult: vi.fn(),
				download: vi.fn(),
				beginLink: vi.fn(),
			},
		});

		const markup = renderToStaticMarkup(<GuestTrialWorkspace />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(visibleText).toContain("Transferred privately for this edit");
		expect(visibleText.match(/Watermarked · available for up to 24 hours/g)).toHaveLength(1);
		expect(visibleText).toContain("16 / 10000");
		expect(markup).not.toContain("private-source-id");
	});

	it("shows the private watermarked result, exact expiry, download, and fenced account actions", () => {
		mocks.useGuestTrial.mockReturnValue({
			view: {
				state: "ready",
				resultAssetId: "guest-output-1",
				resultExpiresAt: "2026-08-29T00:00:00.000Z",
			},
			statusLabel: "Your watermarked preview is ready",
			isSubmitting: false,
			resultUrl: "https://private.test/signed-result",
			actions: {
				submit: vi.fn(),
				viewStatus: vi.fn(),
				viewResult: vi.fn(),
				download: vi.fn(),
				beginLink: vi.fn(),
			},
		});

		const markup = renderToStaticMarkup(<GuestTrialWorkspace />);
		const visibleText = markup.replaceAll(/<[^>]+>/g, " ");

		expect(markup).toContain('src="https://private.test/signed-result"');
		expect(visibleText).toContain("Available until");
		expect(visibleText).toContain("Download watermarked preview");
		expect(visibleText).toContain("Sign in");
		expect(visibleText).toContain("Create account");
		expect(visibleText).toContain("View result");
		expect(visibleText).not.toMatch(/history|edit again|cancel|clean original/i);
	});

	it("uses an alert for failed submission and explains whether the trial was consumed", () => {
		mocks.useGuestTrial.mockReturnValue({
			view: { state: "failed", trialConsumed: true, resultExpiresAt: "2026-08-29T00:00:00.000Z" },
			statusLabel: "This edit could not be completed",
			isSubmitting: false,
			resultUrl: null,
			actions: {
				submit: vi.fn(),
				viewStatus: vi.fn(),
				viewResult: vi.fn(),
				download: vi.fn(),
				beginLink: vi.fn(),
			},
		});

		const markup = renderToStaticMarkup(<GuestTrialWorkspace />);
		expect(markup).toContain('role="alert"');
		expect(markup).toContain("This trial was consumed.");
	});

	it("shows an explicit retry after transient private preview access failure", () => {
		mocks.useGuestTrial.mockReturnValue({
			view: {
				state: "ready",
				jobId: "guest-job-1",
				resultAssetId: "guest-output-1",
				resultExpiresAt: "2026-08-29T00:00:00.000Z",
			},
			errorKey: "access",
			isSubmitting: false,
			resultUrl: null,
			actions: {
				submit: vi.fn(),
				viewStatus: vi.fn(),
				viewResult: vi.fn(),
				retryAccess: vi.fn(),
				download: vi.fn(),
				beginLink: vi.fn(),
			},
		});

		const markup = renderToStaticMarkup(<GuestTrialWorkspace />);
		expect(markup).toContain("Retry private preview");
	});
});
