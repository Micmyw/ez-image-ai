import { getSession } from "@auth/lib/server";
import { CheckoutReturnContent } from "@payments/components/CheckoutReturnContent";
import { createChoosePlanPath, sanitizeEditorReturnPath } from "@payments/lib/editor-upgrade";
import { AuthWrapper } from "@shared/components/AuthWrapper";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("checkoutReturn");

	return {
		title: t("title"),
	};
}

export default async function CheckoutReturnPage({
	searchParams,
}: {
	searchParams: Promise<{
		organizationId?: string | string[];
		expectedPlanId?: string | string[];
		returnTo?: string | string[];
		checkoutIntentId?: string | string[];
		canceled?: string | string[];
		approved?: string | string[];
	}>;
}) {
	const [session, t, params] = await Promise.all([
		getSession(),
		getTranslations("checkoutReturn"),
		searchParams,
	]);

	if (!session) {
		redirect("/login");
	}
	const { expectedPlanId } = params;
	const organizationId =
		typeof params.organizationId === "string" ? params.organizationId : undefined;
	const checkoutIntentId =
		typeof params.checkoutIntentId === "string" ? params.checkoutIntentId.trim() : undefined;
	const canceled = params.canceled !== undefined;
	const safeReturnTo = sanitizeEditorReturnPath(
		typeof params.returnTo === "string" ? params.returnTo : undefined,
	);
	if (
		expectedPlanId !== "creator" &&
		expectedPlanId !== "ultimate" &&
		expectedPlanId !== "studio"
	) {
		redirect(createChoosePlanPath(safeReturnTo));
	}

	return (
		<AuthWrapper>
			<div className="mb-4 text-center">
				<h1 className="font-bold text-2xl lg:text-3xl">{t("title")}</h1>
				<p className="text-sm lg:text-base text-muted-foreground">{t("description")}</p>
			</div>

			<CheckoutReturnContent
				organizationId={organizationId}
				expectedPlanId={expectedPlanId}
				returnTo={safeReturnTo}
				checkoutIntentId={
					checkoutIntentId?.length && checkoutIntentId.length <= 128 ? checkoutIntentId : undefined
				}
				canceled={canceled}
				approved={!canceled && params.approved === "1"}
			/>
		</AuthWrapper>
	);
}
