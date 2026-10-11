"use client";

import { kieZeroCostRejectionEvidenceSchema } from "@repo/config/kie-zero-cost-rejection";
import { Button } from "@repo/ui/components/button";
import { Card } from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

export function KieRejectionRecoveryPanel() {
	const t = useTranslations("admin.media.rejectionRecovery");
	const id = useId();
	const queryClient = useQueryClient();
	const mutation = useMutation(orpc.media.resolveKieZeroCostRejection.mutationOptions());
	const [fields, setFields] = useState({
		attemptId: "",
		providerEvidenceReference: "",
		evidence: "",
		reason: "",
	});
	const [invalidEvidence, setInvalidEvidence] = useState(false);
	const pending = useRef(false);
	const request = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
	const change = (field: keyof typeof fields, value: string) => {
		setFields((previous) => ({ ...previous, [field]: value }));
		setInvalidEvidence(false);
		mutation.reset();
	};
	return (
		<Card className="space-y-4 p-5" id="kie-rejection-recovery">
			<h2 className="text-xl font-semibold">{t("title")}</h2>
			<p className="max-w-3xl text-sm text-muted-foreground">{t("description")}</p>
			<form
				className="space-y-4"
				onSubmit={async (event) => {
					event.preventDefault();
					if (pending.current) return;
					let evidence;
					try {
						evidence = kieZeroCostRejectionEvidenceSchema.parse(JSON.parse(fields.evidence));
						if (evidence.source !== "dashboard-log") throw new Error("Invalid source");
					} catch {
						setInvalidEvidence(true);
						return;
					}
					const input = {
						attemptId: fields.attemptId.trim(),
						providerEvidenceReference: fields.providerEvidenceReference.trim(),
						reason: fields.reason.trim(),
						evidence,
					};
					const fingerprint = JSON.stringify(input);
					if (request.current?.fingerprint !== fingerprint)
						request.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
					pending.current = true;
					try {
						await mutation.mutateAsync({
							...input,
							idempotencyKey: request.current.idempotencyKey,
						});
						await Promise.all([
							queryClient.invalidateQueries({ queryKey: orpc.media.adminMediaDiagnostics.key() }),
							queryClient.invalidateQueries({ queryKey: orpc.media.listMediaAuditLog.key() }),
						]);
					} catch {
						/* Preserve the same request key after an unknown network outcome. */
					} finally {
						pending.current = false;
					}
				}}
			>
				<fieldset disabled={mutation.isPending} className="space-y-3">
					{(["attemptId", "providerEvidenceReference", "reason"] as const).map((field) => (
						<div className="space-y-1" key={field}>
							<label className="text-sm font-medium" htmlFor={`${id}-${field}`}>
								{t(field)}
							</label>
							<Input
								id={`${id}-${field}`}
								value={fields[field]}
								onChange={(event) => change(field, event.target.value)}
								required
								minLength={field === "attemptId" ? 1 : 10}
								maxLength={field === "attemptId" ? 128 : field === "reason" ? 500 : 1000}
							/>
						</div>
					))}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor={`${id}-evidence`}>
							{t("evidence")}
						</label>
						<Textarea
							id={`${id}-evidence`}
							value={fields.evidence}
							onChange={(event) => change("evidence", event.target.value)}
							required
							maxLength={4000}
							rows={7}
							aria-invalid={invalidEvidence}
							aria-describedby={`${id}-evidence-help`}
							className="font-mono text-xs"
						/>
						<p id={`${id}-evidence-help`} className="text-xs text-muted-foreground">
							{t("evidenceHelp")}
						</p>
					</div>
					<Button type="submit" loading={mutation.isPending} disabled={mutation.isSuccess}>
						{t("action")}
					</Button>
				</fieldset>
			</form>
			{invalidEvidence && (
				<p role="alert" className="text-sm text-destructive">
					{t("invalidEvidence")}
				</p>
			)}
			{mutation.isError && (
				<p role="alert" className="text-sm text-destructive">
					{t("error")} <code>{mutation.error.message}</code>
				</p>
			)}
			{mutation.data && (
				<output className="text-sm block">
					{t("queued", { credits: mutation.data.reservedCredits })}{" "}
					<code>{mutation.data.jobId}</code>
				</output>
			)}
		</Card>
	);
}
