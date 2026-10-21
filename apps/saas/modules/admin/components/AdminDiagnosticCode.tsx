"use client";

import { useLocale } from "next-intl";

// Display annotations only. Unknown/provider-specific codes stay intact.
const chineseLabels: Record<string, string> = {
	NO_USABLE_OUTPUT: "没有可交付结果（需结合审查记录确认原因）",
	PROVIDER_POLICY_REJECTED_NO_CHARGE: "服务商因内容政策拒绝，已确认未计费",
	CONTENT_NOT_ALLOWED: "内容未通过审查",
	ASSET_CONTENT_NOT_ALLOWED: "输入图片未通过内容审查",
	SEEAPI_CONTENT_NOT_ALLOWED: "SeeAPI 判定内容不允许",
	CONTENT_REVIEW_REQUIRED: "内容需要人工复核",
	GENERATION_TIMEOUT: "生成超时",
	GENERATION_SERVICE_UNAVAILABLE: "生成服务暂不可用",
	PROVIDER_FAILED: "生成服务商处理失败",
	RESERVED: "已预留积分",
	DISPATCH_QUEUED: "等待调度",
	SUBMITTING: "正在提交",
	PROVIDER_PENDING: "等待服务商处理",
	PROVIDER_RUNNING: "服务商生成中",
	NEEDS_RECONCILIATION: "等待核对处理结果",
	FINALIZING: "正在处理最终结果",
	SUCCEEDED: "已成功",
	FAILED: "已失败",
	CANCELED: "已取消",
	PAYMENT: "支付事件",
	PROVIDER: "生成事件",
	DISPATCH: "调度",
	FINALIZE: "完成结果处理",
	SETTLE: "积分结算",
	active: "有效",
	pending: "待处理",
	completed: "已完成",
	canceled: "已取消",
	failed: "已失败",
	expired: "已过期",
	requires_review: "需要复核",
};

export function AdminDiagnosticCode({ code }: { code: string }) {
	const locale = useLocale();
	const label =
		locale === "zh-CN" && Object.hasOwn(chineseLabels, code) ? chineseLabels[code] : undefined;

	return label ? (
		<span className="break-words">
			{label} <code className="text-xs break-all">({code})</code>
		</span>
	) : (
		<code className="break-all">{code}</code>
	);
}
