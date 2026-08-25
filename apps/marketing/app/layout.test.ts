import { config } from "@config";
import { getBaseUrl } from "@shared/lib/base-url";
import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

describe("marketing root metadata", () => {
	it("uses the configured EzPic identity and image-editing description", () => {
		expect(metadata).toMatchObject({
			applicationName: config.appName,
			description: config.appDescription,
			metadataBase: new URL(getBaseUrl()),
			robots: { index: false, follow: true },
			openGraph: {
				description: config.appDescription,
				siteName: config.appName,
			},
		});
	});
});
