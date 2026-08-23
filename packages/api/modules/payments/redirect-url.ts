import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

const allowedRedirectOrigin = new URL(getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000)).origin;

function isAllowedRedirectUrl(redirectUrl: string) {
	try {
		return new URL(redirectUrl).origin === allowedRedirectOrigin;
	} catch {
		return false;
	}
}

export const paymentRedirectUrlSchema = z
	.url()
	.refine(isAllowedRedirectUrl, {
		message: "Redirect URL must use the application origin",
	})
	.optional();
