import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../../../packages/i18n/translations/en/saas.json";

const mocks = vi.hoisted(() => ({ query: vi.fn(), invalidate: vi.fn(), options: vi.fn() }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		media: new Proxy(
			{},
			{
				get: (_target, name) => ({
					queryOptions: (options: unknown) => {
						mocks.options(name, options);
						return { name };
					},
					mutationOptions: () => ({}),
					key: () => [name],
				}),
			},
		),
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: mocks.query,
	useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
	useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("./CheckoutReviewPanel", () => ({ CheckoutReviewPanel: () => null }));
vi.mock("./GrowthOperationsPanel", () => ({ GrowthOperationsPanel: () => null }));
vi.mock("./ModerationOperationsPanel", () => ({ ModerationOperationsPanel: () => null }));
vi.mock("./KieRejectionRecoveryPanel", () => ({ KieRejectionRecoveryPanel: () => null }));
vi.mock("./PaymentAttributionPanel", () => ({ PaymentAttributionPanel: () => null }));

import { MediaOperations } from "./MediaOperations";

function render() {
	return renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<MediaOperations />
		</NextIntlClientProvider>,
	);
}

const unavailable = {
	data: undefined,
	dataUpdatedAt: 0,
	isError: true,
	isFetching: false,
	isStale: true,
	refetch: async () => {},
};

describe("media operations section failures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.query.mockReturnValue(unavailable);
	});
	it("renders unavailable metrics instead of healthy zero values", () => {
		const html = render();
		expect(html).toContain("Data unavailable");
		expect(html.match(/>—<\/p>/g)).toHaveLength(6);
		expect(html).not.toContain("Within thresholds");
		expect(html).not.toContain("Loading guest operations");
	});
	it("continues to show health when guest and resource queries fail", () => {
		mocks.query.mockImplementation(({ name }) =>
			name === "adminMediaHealth"
				? {
						...unavailable,
						isError: false,
						isStale: false,
						dataUpdatedAt: Date.now(),
						data: {
							queue: { depth: 7, oldestAgeSeconds: 0, stalledJobs: 0, needsReconciliation: 0 },
							outbox: { pending: 0, deadLetter: 0 },
							events: {
								generationFailed: 0,
								payment: {
									failed: { count: 0, items: [] },
									deadLetter: { count: 0, items: [] },
									ignored: { count: 0, items: [] },
								},
							},
							overrides: [],
						},
					}
				: unavailable,
		);
		const html = render();
		expect(html).toMatch(/>7<\/p>/);
		expect(html).toContain("Data unavailable");
		expect(html.match(/>—<\/p>/g)).toHaveLength(2);
	});
	it("uses independently paced queries and omits the historical full read", () => {
		render();
		expect(mocks.options).toHaveBeenCalledWith(
			"adminMediaHealth",
			expect.objectContaining({ refetchInterval: 30_000, refetchIntervalInBackground: false }),
		);
		expect(mocks.options).toHaveBeenCalledWith(
			"adminGuestDiagnostics",
			expect.objectContaining({ refetchInterval: 60_000 }),
		);
		expect(mocks.options).toHaveBeenCalledWith(
			"adminMediaTotals",
			expect.objectContaining({ refetchInterval: 120_000 }),
		);
		expect(mocks.options.mock.calls.some(([name]) => name === "adminMediaDiagnostics")).toBe(false);
	});
});
