import { afterEach, describe, expect, it, vi } from "vitest";

import { buildFeedbackMailto, copyFeedbackEmail, scheduleFeedbackReveal } from "./feedback";

const labels = {
	subjectIdea: "EzImageAI: suggestion",
	subjectBug: "EzImageAI: bug report",
	accountEmail: "Account email (optional)",
	description: "Description",
};

describe("feedback email draft", () => {
	it.each(["idea", "bug"] as const)(
		"encodes a user-written %s without adding hidden context",
		(kind) => {
			const description =
				"Une idée & ein Fehler?\nEspañol: imagen + lumière #1\nBcc: nobody@example.test";
			const href = buildFeedbackMailto(
				"help@configured.test",
				{ kind, accountEmail: " writer+test@example.test ", description },
				labels,
			);
			const url = new URL(href);
			expect(url.protocol).toBe("mailto:");
			expect(url.pathname).toBe("help@configured.test");
			expect([...url.searchParams.keys()]).toEqual(["subject", "body"]);
			expect(url.searchParams.get("subject")).toBe(
				kind === "idea" ? labels.subjectIdea : labels.subjectBug,
			);
			expect(url.searchParams.get("body")).toBe(
				`Account email (optional): writer+test@example.test\n\nDescription:\n${description}`,
			);
			expect(href).not.toMatch(/\n|\r/);
		},
	);
	it("includes only the supplied fields, never a current URL, prompt or request details", () => {
		const href = buildFeedbackMailto(
			"help@configured.test",
			{ kind: "idea", accountEmail: "", description: "A simpler toolbar" },
			labels,
		);
		expect(new URL(href).searchParams.get("body")).toBe(
			"Account email (optional): \n\nDescription:\nA simpler toolbar",
		);
	});
	it("copies only the support email after an explicit call", async () => {
		const writes: string[] = [];
		expect(
			await copyFeedbackEmail("help@configured.test", {
				writeText: async (value) => {
					writes.push(value);
				},
			}),
		).toBe(true);
		expect(writes).toEqual(["help@configured.test"]);
	});
	it("leaves a selectable email fallback when clipboard is missing or denied", async () => {
		expect(await copyFeedbackEmail("help@configured.test", undefined)).toBe(false);
		expect(
			await copyFeedbackEmail("help@configured.test", {
				writeText: async () => {
					throw new Error("denied");
				},
			}),
		).toBe(false);
	});
});

describe("feedback reveal", () => {
	afterEach(() => vi.useRealTimers());
	it("opens once after the short burst even without an animation event", () => {
		vi.useFakeTimers();
		const reveal = vi.fn();
		scheduleFeedbackReveal(reveal, false);
		vi.advanceTimersByTime(399);
		expect(reveal).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(reveal).toHaveBeenCalledTimes(1);
		vi.runAllTimers();
		expect(reveal).toHaveBeenCalledTimes(1);
	});
	it("opens immediately with reduced motion and schedules no animation timer", () => {
		vi.useFakeTimers();
		const reveal = vi.fn();
		scheduleFeedbackReveal(reveal, true);
		expect(reveal).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels a pending reveal on animation completion or unmount", () => {
		vi.useFakeTimers();
		const reveal = vi.fn();
		const cancel = scheduleFeedbackReveal(reveal, false);
		cancel();
		vi.runAllTimers();
		expect(reveal).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
