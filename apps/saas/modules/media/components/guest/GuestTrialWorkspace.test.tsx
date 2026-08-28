import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useGuestTrial: vi.fn() }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		const date = typeof values?.date === "string" ? values.date : "";
		return (
			{
				"states.waiting": "Waiting in the free queue",
				"states.delayed": "This is taking longer than expected",
				"states.ready": "Your watermarked preview is ready",
				"states.failed": "This edit could not be completed",
				viewStatus: "View status",
				viewResult: "View result",
				download: "Download watermarked preview",
				signIn: "Sign in",
				createAccount: "Create account",
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
		render,
		...props
	}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
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

		expect(markup).toContain('aria-live="polite"');
		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain("aspect-");
		expect(markup).toContain("View status");
		expect(markup).not.toMatch(/\d+%|queue position|history|edit again|cancel/i);
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
});
