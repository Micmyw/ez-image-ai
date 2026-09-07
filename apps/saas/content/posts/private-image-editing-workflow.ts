export const blogDocuments = [
	{
		slug: "private-image-editing-workflow",
		locale: "en",
		title: "How EzPic Keeps an Image Edit Private",
		description:
			"A factual walkthrough of EzPic's source-image upload, guest draft, account handoff, and private result flow.",
		publishedAt: "2026-09-05",
		tags: ["image editing", "privacy", "workflow"],
		published: true,
		body: `EzPic is built around editing a source image rather than generating from a prompt alone. The public page lets you choose a supported image, describe the change, and select an available image product and output setting before continuing.

## Start with a supported source image

The public editor accepts JPEG, PNG, and WebP input. It checks the active server capability before presenting an available edit path, and the server remains responsible for enforcing the current byte limit and product access.

## Upload through a private draft

When you continue, the browser requests a short-lived upload intent, sends the source image to the authorized private destination, and asks the server to verify the upload. The browser carries only a stable public product key; Provider routes, model identifiers, credentials, and cost details remain server-side.

## Continue with the access the product requires

When the upload is ready, EzPic posts the claim to the same-origin continuation route. An available Nano Banana 2 Lite 1K guest trial can continue with a temporary anonymous owner. GPT Image 2, Seedream 5 Pro, and other account features follow the sign-in and entitlement path shown in the product.

## Keep the job and result account-scoped

For account-based editing, the server creates a quote before confirmation. A confirmed job reserves credits through the existing ledger and runs asynchronously. Source images and approved results are private assets, and browser access uses short-lived URLs after ownership checks.

## Review every result

Image edits can contain artifacts or unexpected changes. Compare the result with the source and verify that it is suitable before publishing or relying on it.`,
	},
] as const;
