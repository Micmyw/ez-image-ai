"use client";

import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { getEditorErrorKey, type EditorErrorKey } from "../lib/editor-error";

export function RetryGenerationButton({ jobId }: { jobId: string }) {
	const t = useTranslations("media.detail");
	const errors = useTranslations("media.create.errors");
	const router = useRouter();
	const request = useRef<{ jobId: string; key: string; pending: boolean } | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<EditorErrorKey | null>(null);
	async function retry() {
		if (request.current?.pending) return;
		if (request.current?.jobId !== jobId)
			request.current = { jobId, key: crypto.randomUUID(), pending: false };
		const current = request.current;
		current.pending = true;
		setPending(true);
		setError(null);
		try {
			const result = await orpcClient.media.retryGeneration({ jobId, idempotencyKey: current.key });
			router.push(`/create?job=${encodeURIComponent(result.jobId)}`);
		} catch (error) {
			// Keep the same key after a lost response; a repeated click resumes the same retry.
			setError(getEditorErrorKey(error));
			if (
				error instanceof Error &&
				/^(INSUFFICIENT_CREDITS|CREDIT_DEBT_OUTSTANDING|ENTITLEMENT_REQUIRED|ASSET_NOT_READY|TEMPORARY_REFERENCE_EXPIRED|TEMPORARY_REFERENCE_INVALID|CONTENT_NOT_ALLOWED|CONTENT_REVIEW_REQUIRED|TEXT_LANGUAGE_UNSUPPORTED|SAFETY_CHECK_UNAVAILABLE|QUOTE_EXPIRED|PRICE_CHANGED|CONCURRENT_JOB_LIMIT_REACHED|INPUT_TOO_LARGE|MODEL_DISABLED|RATE_LIMITED|BUDGET_EXCEEDED|STORAGE_QUOTA_EXCEEDED|GENERATION_RETRY_FAILED)$/.test(
					error.message,
				)
			) {
				request.current = null;
			}
		} finally {
			current.pending = false;
			setPending(false);
		}
	}
	return (
		<div>
			<Button variant="secondary" loading={pending} disabled={pending} onClick={() => void retry()}>
				{t("retry")}
			</Button>
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{errors(error)}
				</p>
			)}
		</div>
	);
}
