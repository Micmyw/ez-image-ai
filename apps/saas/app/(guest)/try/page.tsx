import { getSession } from "@auth/lib/server";
import { GuestTrialWorkspace } from "@media/components/guest/GuestTrialWorkspace";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function GuestTrialPage() {
	const session = await getSession();
	if (!session) redirect("/login?redirectTo=%2Ftry");
	const registered = !isAnonymousUser(session.user);
	if (registered && !(await cookies()).has("media_guest_link_intent")) redirect("/create");
	return <GuestTrialWorkspace registered={registered} />;
}
