import { getSession } from "@auth/lib/server";
import { GuestTrialWorkspace } from "@media/components/guest/GuestTrialWorkspace";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { EFFECT_EDITOR_RETURN_COOKIE } from "../../../modules/effects/lib/editor-return";
import { resolvePublishedEffectReturnPath } from "../../../modules/effects/lib/editor-return.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function GuestTrialPage() {
	const session = await getSession();
	if (!session) redirect("/login?redirectTo=%2Ftry");
	const registered = !isAnonymousUser(session.user);
	const cookieStore = await cookies();
	const effectReturn = resolvePublishedEffectReturnPath(
		cookieStore.get(EFFECT_EDITOR_RETURN_COOKIE)?.value,
	);
	if (registered && !cookieStore.has("media_guest_link_intent"))
		redirect(effectReturn ?? "/create");
	const t = await getTranslations("effects.editor");
	return (
		<>
			{effectReturn && (
				<div className="px-4 pt-4 sm:px-6 mx-auto max-w-[90rem]">
					<a
						href={effectReturn}
						className="min-h-11 text-sm font-semibold inline-flex items-center underline underline-offset-4"
					>
						{t("returnToEffect")}
					</a>
				</div>
			)}
			<GuestTrialWorkspace registered={registered} effectReturnPath={effectReturn ?? undefined} />
		</>
	);
}
