import { z } from "zod";

const publicReasonCodeSchema = z.enum([
	"ACCOUNT_INPUT_COPY_FAILED",
	"ACCOUNT_INPUT_COPY_EXPIRED",
	"ACCOUNT_INPUT_COPY_UNAVAILABLE",
]);

export const accountInputCopyStatusSchema = z
	.object({
		promotionId: z.string().min(1),
		status: z.enum(["COPYING", "VERIFYING", "READY", "FAILED", "EXPIRED"]),
		reasonCode: publicReasonCodeSchema.optional(),
	})
	.strict();

export type AccountInputCopyStatus = z.infer<typeof accountInputCopyStatusSchema>;

export function publicAccountInputCopyStatus(value: {
	promotionId: string;
	status: AccountInputCopyStatus["status"];
	reasonCode?: string;
}): AccountInputCopyStatus {
	const reason = publicReasonCodeSchema.safeParse(value.reasonCode);
	return {
		promotionId: value.promotionId,
		status: value.status,
		...(value.reasonCode
			? { reasonCode: reason.success ? reason.data : ("ACCOUNT_INPUT_COPY_UNAVAILABLE" as const) }
			: {}),
	};
}
