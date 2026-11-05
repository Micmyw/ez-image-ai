import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../../packages/i18n/translations/en/saas.json";
import chinese from "../../lib/messages/zh-CN.json";
import { DiagnosticsStatus } from "./DiagnosticsStatus";

function render(
	query: { data?: unknown; dataUpdatedAt?: number; isError?: boolean },
	locale = "en",
) {
	return renderToStaticMarkup(
		<NextIntlClientProvider
			locale={locale}
			messages={locale === "zh-CN" ? { admin: chinese } : locale === "en" ? en : de}
			timeZone="UTC"
		>
			<DiagnosticsStatus
				title="Health"
				intervalMs={30_000}
				query={{
					data: undefined,
					dataUpdatedAt: 0,
					isError: false,
					isFetching: false,
					refetch: vi.fn(async () => undefined),
					...query,
				}}
			/>
		</NextIntlClientProvider>,
	);
}

afterEach(() => vi.restoreAllMocks());

describe("diagnostics freshness feedback", () => {
	it("shows unavailable data after an initial failure", () => {
		const html = render({ isError: true });
		expect(html).toContain("Data unavailable");
		expect(html).toContain('role="alert"');
		expect(html).not.toContain("Up to date");
	});
	it("identifies retained data after a refresh failure", () => {
		const html = render({ data: {}, dataUpdatedAt: Date.now(), isError: true });
		expect(html).toContain("showing previous data");
		expect(html).toContain("Last successful update");
	});
	it("marks aged data stale even without a fetch error", () => {
		vi.spyOn(Date, "now").mockReturnValue(100_000);
		expect(render({ data: {}, dataUpdatedAt: 1_000 })).toContain("Data is out of date");
	});
	it("renders German failure and manual-refresh text", () => {
		const html = render({ isError: true }, "de");
		expect(html).toContain("Daten nicht verfügbar");
		expect(html).toContain("Aktualisieren");
	});
	it("renders the private Chinese admin language", () => {
		const html = render({ isError: true }, "zh-CN");
		expect(html).toContain("数据暂不可用");
		expect(html).toContain("刷新");
	});
});
