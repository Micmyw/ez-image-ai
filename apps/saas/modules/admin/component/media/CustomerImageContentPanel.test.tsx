import type { AdminImageContentDetail } from "@repo/api/modules/media/admin-content-types";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));
import german from "../../../../../../packages/i18n/translations/de/saas.json";
import english from "../../../../../../packages/i18n/translations/en/saas.json";
import spanish from "../../../../../../packages/i18n/translations/es/saas.json";
import french from "../../../../../../packages/i18n/translations/fr/saas.json";
import chinese from "../../lib/messages/zh-CN.json";
import { AdminImageContentView } from "./CustomerImageContentPanel";

const input: AdminImageContentDetail["image"] = {
	id: "customer-input",
	kind: "INPUT",
	role: "INPUT",
	status: "READY",
	createdAt: new Date(),
	availability: "AVAILABLE",
	previewUrl: "https://example.invalid/input.png",
	previewError: false,
	review: null,
};
const output: AdminImageContentDetail["image"] = {
	...input,
	id: "blocked-output",
	kind: "OUTPUT",
	role: "OUTPUT",
	status: "QUARANTINED",
	previewUrl: "https://example.invalid/output.png",
	review: {
		provider: "seeapi",
		providerTaskId: "task",
		status: "REJECTED",
		reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
		createdAt: new Date(),
		current: true,
		flagged: true,
		nsfw: ["sexual_activity"],
		specialCare: ["possible_minor"],
	},
};
function detail(): AdminImageContentDetail {
	return {
		ownerType: "USER",
		ownerId: "customer",
		image: output,
		relatedImages: [input],
		jobs: [
			{
				id: "job",
				status: "FAILED",
				productKey: "image-minimax-h3",
				failureCode: "OUTPUT_CONTENT_BLOCKED_WAIVED",
				createdAt: new Date(),
			},
		],
		selectedJobId: "job",
		prompt: "Customer editing prompt",
		promptRecords: [],
	};
}
function render(data = detail(), locale: "zh-CN" | "de" = "zh-CN") {
	return renderToStaticMarkup(
		<NextIntlClientProvider
			locale={locale}
			timeZone="UTC"
			messages={locale === "de" ? german : { ...english, admin: chinese }}
		>
			<AdminImageContentView detail={data} />
		</NextIntlClientProvider>,
	);
}
describe("customer image inspection presentation", () => {
	it("displays customer originals, blocked outputs, prompts and recorded classifier labels", () => {
		const html = render();
		expect(html).not.toContain("这条记录没有关联的已保存提示词");
		for (const text of [
			'alt="客户输入图片"',
			'alt="生成图片"',
			"Customer editing prompt",
			"seeapi",
			"sexual_activity",
			"possible_minor",
			"SEEAPI_CONTENT_NOT_ALLOWED",
		])
			expect(html).toContain(text);
	});
	it("supports customer uploads without a job", () => {
		const html = render({
			...detail(),
			image: input,
			relatedImages: [],
			jobs: [],
			selectedJobId: null,
			prompt: null,
		});
		expect(html).toContain("这张图片尚无关联生成任务");
		expect(html).toContain('alt="客户输入图片"');
	});
	it("shows saved draft prompts for uploads without a job", () => {
		const html = render({
			...detail(),
			image: input,
			relatedImages: [],
			jobs: [],
			selectedJobId: null,
			prompt: null,
			promptRecords: [
				{
					id: "saved-draft",
					prompt: "Saved upload editing prompt",
					productKey: "image-minimax-h3",
					source: "REFERENCE_DRAFT",
					createdAt: new Date(),
					jobId: null,
				},
			],
		});
		expect(html).toContain("Saved upload editing prompt");
	});
	it("explains deleted content without rendering a broken preview", () => {
		const html = render({
			...detail(),
			relatedImages: [],
			image: { ...output, previewUrl: null, availability: "DELETED" },
		});
		expect(html).toContain("这张图片已删除");
		expect(html).not.toContain("<img");
	});
	it("labels historical evidence and renders German content", () => {
		const data = detail();
		data.image = { ...output, review: { ...output.review!, current: false } };
		expect(render(data)).toContain("历史结果");
		expect(render(data, "de")).toContain("Eingabebild des Kunden");
		expect(render(data, "de")).toContain("Historische Prüfung");
	});
	it("separates Waffo and model message provenance from authenticated terminal status", () => {
		const html = render({
			...detail(),
			audience: "GUEST",
			promptReviews: [
				{
					id: "waffo-review",
					createdAt: new Date(),
					provider: "waffo",
					decision: "REJECT",
					reasonCode: "TEXT_CONTENT_NOT_ALLOWED",
					action: "block",
					semanticStatus: "scored",
					categories: ["adult_nsfw"],
				},
			],
			attempts: [
				{
					id: "attempt",
					provider: "kie",
					providerTaskId: "task",
					status: "FAILED",
					createdAt: new Date(),
					uncertainSubmission: false,
					errorCode: "PROVIDER_TEMPORARY",
					errorMessage: "Upstream timeout",
					messageSource: "CALLBACK_DIAGNOSTIC",
					messageObservedAt: "2026-11-14T00:00:00.000Z",
					terminalStatus: null,
					verifiedAt: null,
					evidenceSource: "STORED_DIAGNOSTIC",
				},
			],
		});
		expect(html).toContain("Waffo 提示词审核");
		expect(html).toContain("adult_nsfw");
		expect(html).toContain("Upstream timeout");
		expect(html).toContain("回调诊断，不能作为已认证供应商结论");
		expect(html).not.toContain("已认证的供应商查询结果");
	});
	it("distinguishes a queued tombstone from confirmed R2 deletion", () => {
		const queued = render({ ...detail(), cleanup: { state: "QUEUED", attempts: 0 } });
		expect(queued).toContain("R2 删除已排队");
		expect(queued).not.toContain("已确认 R2 物理删除");
		expect(render({ ...detail(), cleanup: { state: "COMPLETED", attempts: 1 } })).toContain(
			"已确认 R2 物理删除",
		);
	});
	it("keeps content translation keys aligned across supported languages", () => {
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
			expect(leaves(media.content)).toEqual(leaves(english.admin.media.content));
	});
});
