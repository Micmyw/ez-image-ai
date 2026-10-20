import type { Metadata } from "next";

import { SupportWorkspace } from "../../../../../../modules/support/components/SupportWorkspace";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function SupportPage() {
	return <SupportWorkspace />;
}
