import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	data: undefined as unknown,
	isError: false,
	options: {} as Record<string, unknown>,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: Record<string, unknown>) => {
		state.options = options;
		return state;
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { media: { getGenerationDuration: { queryOptions: (options: unknown) => options } } },
}));
vi.mock("next-intl", () => ({
	useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		key === "processing"
			? "Your image is processing."
			: key === "range"
				? `Recent completed tasks: ${String(values?.minimum)}–${String(values?.maximum)} seconds (P50–P90).`
				: `Based on ${String(values?.count)} completed tasks. Marked internal tasks excluded. Updated ${String(values?.asOf)}.`,
}));

import { GenerationDurationEstimate } from "./GenerationDurationEstimate";

const props = { productKey: "image-nano-banana-2-lite", skuKey: "nano-banana-2-lite-1k" };
const now = new Date("2026-11-14T10:00:00Z");
const range = {
	kind: "range",
	minimumSeconds: 40,
	maximumSeconds: 70,
	sampleSize: 5,
	asOf: now.toISOString(),
	latestSampleAt: "2026-11-14T08:00:00.000Z",
	percentiles: "p50-p90",
	windowHours: 168,
	cohort: "completed-tasks-excluding-marked-internal",
};
afterEach(() => {
	vi.useRealTimers();
	state.data = undefined;
	state.isError = false;
});

describe("observed generation duration", () => {
	it("shows the observed distribution and basis, without a countdown", () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		state.data = range;
		const first = renderToStaticMarkup(<GenerationDurationEstimate {...props} />);
		expect(first).toContain("40–70 seconds (P50–P90)");
		expect(first).toContain("5 completed tasks");
		expect(first).toContain("Marked internal tasks excluded");
		vi.advanceTimersByTime(20_000);
		expect(renderToStaticMarkup(<GenerationDurationEstimate {...props} />)).toBe(first);
	});
	it.each([
		undefined,
		{ kind: "processing" },
		{ ...range, latestSampleAt: "2026-11-13T08:00:00.000Z" },
	])("shows no seconds without fresh sufficient observations: %o", (data) => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		state.data = data;
		const html = renderToStaticMarkup(<GenerationDurationEstimate {...props} />);
		expect(html).toContain("Your image is processing.");
		expect(html).not.toContain("seconds");
	});
	it("does not retain a range after query failure or request an inactive/invalid selection", () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		state.data = range;
		state.isError = true;
		expect(renderToStaticMarkup(<GenerationDurationEstimate {...props} />)).not.toContain(
			"seconds",
		);
		expect(renderToStaticMarkup(<GenerationDurationEstimate {...props} active={false} />)).toBe("");
		expect(state.options.enabled).toBe(false);
		renderToStaticMarkup(<GenerationDurationEstimate {...props} skuKey="unknown" />);
		expect(state.options.enabled).toBe(false);
	});
});
