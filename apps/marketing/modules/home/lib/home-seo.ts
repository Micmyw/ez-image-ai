import { config } from "@config";

export const HOME_TITLE = "AI Image Editor No Restrictions — Edit Images with Prompts | EzPic";
export const HOME_DESCRIPTION =
	"Upload an image and describe the change. Edit backgrounds, objects, colors, lighting and styles with private AI image editing and transparent credits. Start with free credits.";

export function buildHomeStructuredData(baseUrl: string) {
	const canonical = new URL("/", baseUrl).href;
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${canonical}#website`,
				name: config.appName,
				url: canonical,
			},
			{
				"@type": "SoftwareApplication",
				"@id": `${canonical}#application`,
				name: config.appName,
				applicationCategory: "MultimediaApplication",
				operatingSystem: "Web",
				description: HOME_DESCRIPTION,
				url: canonical,
			},
		],
	};
}
