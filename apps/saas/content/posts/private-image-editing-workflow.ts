export const blogDocuments = [
	{
		slug: "private-image-editing-workflow",
		locale: "en",
		title: "Private AI Image Editing: Uploads, Access, and Retention",
		description:
			"Understand who can access an EzImageAI edit, how guest and account media differ, when files expire, and what to check before uploading a photo.",
		publishedAt: "2026-09-05",
		updatedAt: "2026-09-18",
		tags: ["image editing", "privacy", "workflow"],
		published: true,
		body: `A private image edit limits who can open the uploaded source and finished result. In EzImageAI, those files belong to the account or temporary guest session that created the edit; they are not automatically added to a public gallery. Private access does not mean that no processing service receives your image.

## Before uploading a source

Choose a JPEG, PNG, or WebP image you have permission to edit. Check the upload limit shown in the [editor](/#image-editor) and crop away unrelated personal information before uploading. For a portrait, also consider the subject's permission and the intended use of the result.

EzImageAI uses hosting, storage, safety checks, and image-processing services to handle an edit. Do not treat the word "private" as a promise of offline processing or as a reason to upload material you are not comfortable having processed. The [Privacy Policy](/privacy) describes the data handling and analytics behavior.

## Guest edits are temporary

When the Nano Banana 2 Lite 1K guest trial is available, it uses a temporary session and returns one watermarked preview. Guest source images and results expire within 24 hours of the trial job being created. A public-page draft expires within one hour if you do not continue.

Download a result you want to keep before its expiry. If you sign in or register from an active trial, the linked result keeps its original watermark and expiry. It does not become a saved History item or gain an **Edit again** action.

## Account media has a different lifecycle

For account-based editing, any source image must belong to your account. The generation button shows the credit cost; one click checks the prompt and current price before starting the job. You can also generate from text without a source image. The current retention settings target 30 days for registered input and output media and 7 days for failed-job cleanup. Keep your own copy of work you need for longer. Billing and security records can have different retention periods.

When you open or download a result, EzImageAI checks ownership and issues a temporary access link. Do not forward that link: someone holding a valid signed link may be able to use it until it expires. Share a downloaded image through a channel you control if you intend to publish it.

## Deletion and support

Use the available account and media controls to delete eligible content. Deletion prevents new access links and schedules storage cleanup; backup copies can take longer to age out. For access or deletion questions, [contact support](/contact) from the email associated with your account. Describe the affected feature without including passwords, session cookies, or signed media links.

## Review every result

Compare the result with the source before publishing. Check faces, text, logos, edges, and any details the instruction asked to preserve. Private storage does not establish commercial rights or guarantee an error-free image.

Read the [quick start](/docs/quick-start) for the editing steps, the [prompt guide](/blog/ai-image-editing-prompts) for clearer instructions, or [credits documentation](/docs/credits) to understand charges and recovery.`,
	},
] as const;
