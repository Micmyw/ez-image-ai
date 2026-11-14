import type { AdminContentCleanupPlan } from "@repo/api/modules/media/admin-content-cleanup-types";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));
import english from "../../../../../../packages/i18n/translations/en/saas.json";
import chinese from "../../lib/messages/zh-CN.json";
import { AdminCleanupPlanSummary } from "./AdminContentCleanupPanel";

describe("administrator cleanup preview", () => {
	it("shows exact selected counts, bytes and blocked active drafts without private object identity", () => {
		const plan: AdminContentCleanupPlan = {
			planId: "plan",
			planHash: "a".repeat(64),
			expiresAt: new Date("2026-11-14T10:00:00.000Z"),
			assetCount: 1,
			assetBytes: "512",
			logCount: 2,
			logBytes: 256,
			confirmation: "DELETE 1 ASSETS AND 2 INTERNAL LOGS",
			assets: [
				{ id: "removable", bytes: "512", blocked: [] },
				{ id: "draft-image", bytes: "1024", blocked: ["ACTIVE_DRAFT"] },
			],
		};
		const html = renderToStaticMarkup(
			<NextIntlClientProvider
				locale="zh-CN"
				timeZone="UTC"
				messages={{ ...english, admin: chinese }}
			>
				<AdminCleanupPlanSummary plan={plan} />
			</NextIntlClientProvider>,
		);
		expect(html).toContain("512");
		expect(html).toContain("draft-image");
		expect(html).toContain("有活动草稿使用该图片");
		expect(html).toContain("本计划可删除");
		expect(html).not.toMatch(/objectKey|checksum|rawEnvelope/);
	});
});
