import type { AdminContentCustomer } from "@repo/api/modules/media/admin-customer-content-types";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import english from "../../../../../../packages/i18n/translations/en/saas.json";
import chinese from "../../lib/messages/zh-CN.json";

const mocks = vi.hoisted(() => ({ query: vi.fn(), options: vi.fn() }));
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
				}),
			},
		),
	},
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
vi.mock("./AdminContentCleanupPanel", () => ({
	AdminContentCleanupPanel: () => <div>Existing cleanup controls</div>,
}));
vi.mock("./CustomerImageContentPanel", () => ({ CustomerImageDialog: () => null }));
vi.mock("./AdminPromptContentPanel", () => ({ PromptDetailDialog: () => null }));
import { CustomerContentDetail, CustomerContentPanel } from "./CustomerContentPanel";

const customer: AdminContentCustomer = {
	ownerType: "GUEST_BROWSER",
	ownerId: "browser_example1234",
	name: null,
	email: null,
	audience: "GUEST",
	lastActivityAt: new Date("2026-11-15T07:00:00Z"),
	inputCount: 3,
	outputCount: 1,
	jobCount: 2,
	blockedCount: 1,
	issueCount: 2,
};
const render = (children: React.ReactNode) =>
	renderToStaticMarkup(
		<NextIntlClientProvider
			locale="zh-CN"
			messages={{ ...english, admin: chinese }}
			timeZone="Asia/Shanghai"
		>
			{children}
		</NextIntlClientProvider>,
	);
beforeEach(() => {
	vi.clearAllMocks();
});
describe("customer-first media content", () => {
	it("shows a single browser-level guest entry and one entry action", () => {
		mocks.query.mockReturnValue({
			data: { items: [customer], nextCursor: null },
			refetch: vi.fn(),
		});
		const html = render(<CustomerContentPanel />);
		expect(html).toContain("游客浏览器 · mple1234");
		expect(html).toContain("同一浏览器");
		expect(html).toContain("查看全部内容");
		expect(html).not.toContain("提示词与失败任务");
	});
	it("requests all history for exactly the selected identity and mixes all content kinds", () => {
		mocks.query.mockReturnValue({
			data: {
				items: ["INPUT", "OUTPUT", "JOB", "BLOCKED_REQUEST"].map((recordKind, index) => ({
					...customer,
					id: `record-${index}`,
					createdAt: customer.lastActivityAt,
					recordKind,
					productKey: null,
					status: "READY",
					reasonCode: null,
					hasPrompt: true,
					isIssue: false,
				})),
				nextCursor: null,
			},
			refetch: vi.fn(),
		});
		const html = render(<CustomerContentDetail customer={customer} onBack={() => {}} />);
		expect(mocks.options).toHaveBeenCalledWith("adminCustomerContent", {
			input: { limit: 25, owner: { ownerType: "GUEST_BROWSER", ownerId: customer.ownerId } },
		});
		for (const text of [
			"上传图片",
			"生成图片",
			"生成任务",
			"被拒绝的提示词",
			"返回用户列表",
			"查看图片与审核",
			"查看提示词与任务",
			"此标识代表浏览器",
			"Existing cleanup controls",
		])
			expect(html).toContain(text);
		expect(html).not.toContain('type="checkbox" checked');
	});
	it("does not describe a historical upload ID as a distinct visitor", () => {
		mocks.query.mockReturnValue({ data: { items: [], nextCursor: null }, refetch: vi.fn() });
		const html = render(
			<CustomerContentDetail
				customer={{ ...customer, ownerType: "USER", ownerId: "guest_upload_historical" }}
				onBack={() => {}}
			/>,
		);
		expect(html).toContain("未关联上传");
		expect(html).toContain("不将其认定为独立访客");
	});
	it("reports failed refreshes alongside cached records", () => {
		mocks.query.mockReturnValue({
			data: { items: [customer], nextCursor: null },
			isError: true,
			refetch: vi.fn(),
		});
		expect(render(<CustomerContentPanel />)).toContain("当前显示的内容可能不是最新的");
	});
});
