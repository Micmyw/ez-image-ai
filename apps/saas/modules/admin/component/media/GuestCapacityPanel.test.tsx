import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import german from "../../../../../../packages/i18n/translations/de/saas.json";
import english from "../../../../../../packages/i18n/translations/en/saas.json";
import { getAdminDisplayMessages } from "../../lib/messages";

const mocks = vi.hoisted(() => ({ query: vi.fn(), options: vi.fn() }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		media: new Proxy(
			{},
			{
				get: (_target, name) => ({
					queryOptions: (options: unknown) => {
						mocks.options(name, options);
						return { queryKey: [name] };
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
	useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
	useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { GuestCapacityPanel } from "./GuestCapacityPanel";

function render(locale = "en", messages = english) {
	return renderToStaticMarkup(
		<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
			<GuestCapacityPanel />
		</NextIntlClientProvider>,
	);
}

describe("guest identity capacity panel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.query.mockReturnValue({
			data: {
				generatedAt: new Date().toISOString(),
				maximumTemporaryPrincipals: 100,
				anonymousPrincipals: 20,
				activePrincipalLeases: 2,
				used: 22,
				remaining: 78,
				source: "environment",
				version: 0,
			},
			dataUpdatedAt: Date.now(),
			isError: false,
			isFetching: false,
			refetch: vi.fn(),
		});
	});
	it("renders actual capacity and occupancy with an editable positive integer field", () => {
		const html = render();
		expect(html).toContain("Guest identity capacity");
		expect(html).toContain(">100</dd>");
		expect(html).toContain(">22</dd>");
		expect(html).toContain(">78</dd>");
		expect(html).toContain('value="100"');
		expect(html).toContain('min="1"');
		expect(html).toContain("Includes 2 identities being created.");
		expect(html).toContain("Save capacity");
		expect(mocks.options).toHaveBeenCalledWith(
			"adminGuestCapacity",
			expect.objectContaining({
				refetchInterval: 60_000,
				refetchIntervalInBackground: false,
			}),
		);
	});
	it("renders German capacity labels", () => {
		expect(render("de", german)).toContain("Kapazität für Gastidentitäten");
	});
	it("renders the private Chinese administrator labels", () => {
		const html = render("zh-CN", { ...english, admin: getAdminDisplayMessages(english.admin) });
		expect(html).toContain("游客身份名额");
		expect(html).toContain("剩余名额");
		expect(html).toContain("保存容量");
	});
	it("reports unavailable reads without presenting a zero balance or a save form", () => {
		mocks.query.mockReturnValue({
			data: undefined,
			dataUpdatedAt: 0,
			isError: true,
			isFetching: false,
			refetch: vi.fn(),
		});
		const html = render();
		expect(html).toContain("Data unavailable");
		expect(html).not.toContain("<form");
		expect(html).not.toContain(">0</dd>");
	});
});
