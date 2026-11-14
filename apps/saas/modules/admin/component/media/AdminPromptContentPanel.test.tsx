import type { AdminPromptContentDetail } from "@repo/api/modules/media/admin-prompt-content-types";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));
import german from "../../../../../../packages/i18n/translations/de/saas.json";
import english from "../../../../../../packages/i18n/translations/en/saas.json";
import spanish from "../../../../../../packages/i18n/translations/es/saas.json";
import french from "../../../../../../packages/i18n/translations/fr/saas.json";
import chinese from "../../lib/messages/zh-CN.json";
import { AdminPromptContentDetailBody } from "./AdminPromptContentPanel";

const at = new Date("2026-11-14T00:00:00.000Z");
function detail(): AdminPromptContentDetail {
	return {
		id: "job-without-assets",
		recordKind: "JOB",
		createdAt: at,
		ownerType: "USER",
		ownerId: "customer",
		submittedByUserId: "customer",
		accountEmail: "customer@example.test",
		audience: "ACCOUNT",
		audienceBasis: "JOB_RECORD",
		jobId: "job-without-assets",
		productKey: "image-minimax-h3",
		status: "FAILED",
		failureCode: "PROVIDER_FAILED",
		failureMessage: null,
		prompt: null,
		promptTruncated: false,
		promptSource: "JOB_INPUT_SNAPSHOT",
		promptReviews: [],
		attempts: [],
	};
}
function render(data = detail(), locale: "zh-CN" | "de" = "zh-CN") {
	return renderToStaticMarkup(
		<NextIntlClientProvider
			locale={locale}
			timeZone="UTC"
			messages={locale === "de" ? german : { ...english, admin: chinese }}
		>
			<AdminPromptContentDetailBody data={data} />
		</NextIntlClientProvider>,
	);
}

describe("asset-independent administrator prompt presentation", () => {
	it("keeps absent historical prompts, reviews and model messages explicitly missing", () => {
		const html = render();
		expect(html).toContain("这条记录没有保存提示词");
		expect(html).toContain("没有保存匹配的审核记录");
		expect(html).toContain("没有保存模型消息");
		expect(html).toContain('data-clarity-mask="true"');
		expect(html).not.toMatch(/<pre|<img/);
	});
	it("shows source-free Waffo evidence and recorded guest identity after account promotion", () => {
		const html = render({
			...detail(),
			recordKind: "BLOCKED_REQUEST",
			jobId: null,
			audience: "GUEST",
			audienceBasis: "RECORDED",
			prompt: "Customer’s saved prompt",
			promptSource: "BLOCKED_AUDIT_METADATA",
			status: "REJECT",
			promptReviews: [
				{
					id: "waffo-audit",
					createdAt: at,
					provider: "waffo",
					decision: "REJECT",
					reasonCode: "WAFFO_RESTRICTED_CONTENT",
					action: "block",
					semanticStatus: "scored",
					categories: ["adult_nsfw"],
					ruleVersion: "rules-v1",
					requestId: "review-request",
					evidenceSource: "PERSISTED_AUDIT",
				},
			],
		});
		for (const text of [
			"被拒绝的提示词请求",
			"请求发生时已记录",
			"Customer’s saved prompt",
			"waffo",
			"adult_nsfw",
			"rules-v1",
			"review-request",
			"block",
			"scored",
		])
			expect(html).toContain(text);
		expect(html).not.toContain("没有保存匹配的审核记录");
	});
	it("distinguishes callback messages from terminal evidence without upgrading their provenance", () => {
		const html = render({
			...detail(),
			attempts: [
				{
					id: "attempt",
					provider: "kie",
					providerTaskId: "task",
					status: "FAILED",
					uncertainSubmission: false,
					createdAt: at,
					errorCode: "PROVIDER_TEMPORARY",
					errorMessage: "Upstream timeout",
					messageSource: "CALLBACK_DIAGNOSTIC",
					messageObservedAt: at.toISOString(),
					terminalStatus: null,
					verifiedAt: null,
					evidenceSource: "STORED_DIAGNOSTIC",
				},
			],
		});
		expect(html).toContain("Upstream timeout");
		expect(html).toContain("回调诊断，不能作为已认证供应商结论");
		expect(html).toContain("没有已认证的终态证据");
		expect(html).not.toContain("已认证的供应商终态查询");
	});
	it("does not invent a model message from authenticated terminal status or render arbitrary envelopes", () => {
		const data = {
			...detail(),
			prompt: "<script>alert('private prompt')</script>",
			rawEnvelope: {
				url: "https://private.invalid/signed?token=secret",
				message: "Never render me",
			},
			attempts: [
				{
					id: "attempt",
					provider: "kie",
					providerTaskId: "task",
					status: "FAILED",
					uncertainSubmission: true,
					createdAt: at,
					errorCode: null,
					errorMessage: null,
					messageSource: "STORED_DIAGNOSTIC" as const,
					messageObservedAt: null,
					terminalStatus: "FAILED",
					verifiedAt: at.toISOString(),
					evidenceSource: "AUTHENTICATED_RETRIEVAL" as const,
				},
			],
		};
		const html = render(data);
		expect(html).toContain("没有保存模型消息");
		expect(html).toContain("已认证的供应商终态查询");
		expect(html).toContain("供应商是否接受请求仍不确定");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toMatch(/<script|private\.invalid|Never render me|rawEnvelope/);
	});
	it("keeps all supported translation keys aligned and renders German missing evidence", () => {
		function leaves(value: unknown): string[] {
			return Object.entries(value as Record<string, unknown>)
				.flatMap(([key, child]) =>
					typeof child === "string" ? [key] : leaves(child).map((leaf) => `${key}.${leaf}`),
				)
				.sort();
		}
		for (const media of [
			german.admin.media,
			spanish.admin.media,
			french.admin.media,
			chinese.media,
		])
			expect(leaves(media.prompts)).toEqual(leaves(english.admin.media.prompts));
		expect(render(detail(), "de")).toContain("In diesem Datensatz wurde kein Prompt gespeichert");
	});
});
