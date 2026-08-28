import { GuestShell } from "@media/components/guest/GuestShell";
import type { PropsWithChildren } from "react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function GuestLayout({ children }: PropsWithChildren) {
	return <GuestShell>{children}</GuestShell>;
}
