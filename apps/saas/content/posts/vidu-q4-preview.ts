import type { BlogPost } from "../../modules/public-content/lib/blog-types";

export const viduQ4PreviewDocuments = [
	{
		id: "vidu-q4-preview",
		slug: "vidu-q4-preview",
		locale: "en",
		title: "Vidu Q4 Preview: Features, Pricing & API Guide",
		description:
			"Explore Vidu Q4 Preview's image and reference video workflows, documented limits, pricing sources and prompt ideas. Try Q4 on Vidu; it is not offered by EzImageAI.",
		publishedAt: "2026-10-11",
		updatedAt: "2026-10-11",
		articleType: "guides",
		categoryId: "prompt-writing",
		tags: ["vidu q4 preview", "video", "image to video", "prompts"],
		authorId: "ezimageai-editorial",
		relatedEffectIds: [],
		sources: [
			{
				title: "Vidu: official Q4 page and trial entry",
				url: "https://www.vidu.com/vidu-q4",
				accessedAt: "2026-10-11",
			},
			{
				title: "Vidu API: October 7, 2026 model release notice",
				url: "https://platform.vidu.com/docs/api-reference/updates",
				accessedAt: "2026-10-11",
			},
			{
				title: "Vidu Q4 Preview API: image to video",
				url: "https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/image-to-video",
				accessedAt: "2026-10-11",
			},
			{
				title: "Vidu Q4 Preview API: reference to video",
				url: "https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/reference-to-video",
				accessedAt: "2026-10-11",
			},
			{
				title: "Vidu Open Platform: API pricing and credit consumption",
				url: "https://platform.vidu.com/docs/overview/pricing",
				accessedAt: "2026-10-11",
			},
			{
				title: "Vidu Q3 API: text to video",
				url: "https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video",
				accessedAt: "2026-10-11",
			},
		],
		published: true,
		body: `**Vidu Q4 Preview** is a Vidu video model released on October 7, 2026, according to the [official API release notice](https://platform.vidu.com/docs/api-reference/updates). Its documented workflows turn a starting image or a set of references into a short video, with optional generated sound and output resolutions up to 4K.

> Q4 Preview is available through Vidu's official service and API. EzImageAI does not currently offer Vidu Q4 Preview. This is a documentation-based guide, not a hands-on review or a Q4 generator.

[Try Q4 Preview on Vidu's official site](https://www.vidu.com/vidu-q4). To work with other models here, [explore EzImageAI's video editor](/create?mode=video); check the model name and current quote before generating.

**Last checked: October 11, 2026.** The limits below describe Vidu's published API documentation. The consumer interface, account availability and later preview revisions can differ. We have not paid for or run a Q4 generation for this article.

## Choose the workflow for your material

| Your task | Q4 workflow | Preparation |
| --- | --- | --- |
| Animate an existing product shot | Image to video | One clear starting image; describe one camera move and one action |
| Combine a character, location and visual style | Reference to video | Assign a purpose to each reference and describe how they belong in one scene |
| Make a character speak with a supplied voice reference | Reference to video with sound | Use an authorized voice recording, a short line of dialogue and clear speaker roles |
| Start from text alone | Check another documented workflow | The Q4 endpoints below require image input; a prompt alone is insufficient |

A product close-up and a multi-character scene need different preparation. For a close-up, remove competing background details from the starting image. For references, avoid contradictory wardrobe, lighting or object designs across the set. These are planning suggestions, not measured success rates.

## Documented inputs and output limits

The [image-to-video API](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/image-to-video) and [reference-to-video API](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/reference-to-video) describe these settings:

| Setting | Image to video | Reference to video |
| --- | --- | --- |
| Image input | Exactly one starting image | 1–15 reference images |
| Prompt | Optional in the API | Required in the API |
| Voice references | Not listed for this endpoint | 0–3 MP3 files, each 3–12 seconds |
| Duration | 3–16 whole seconds | 3–16 whole seconds |
| Output resolution | 540p, 720p, 1080p, 2K or 4K | 540p, 720p, 1080p, 2K or 4K |
| Generated audio | Enabled by default; can be turned off | Enabled by default; can be turned off |
| Framing | Starting image determines composition | 1:1, 9:16, 16:9, 3:4 or 4:3 |

Vidu's consumer-page FAQ gives a 1–16 second range for reference-to-video, while the current API specifies 3–16. Use the API range when planning an integration and verify shorter durations in the actual consumer interface before relying on them.

### What 4K and audio mean here

**4K is a documented output option.** These sources do not establish native 4K generation or guarantee sharper detail for every source image. A larger output cannot be assumed to repair a blurred face, unreadable label or inconsistent reference.

Generated audio and a voice reference are separate controls. The audio option requests sound in the output; a reference recording supplies an example voice for the reference workflow. Neither means that an uploaded song is licensed, that a voice is authorized or that every spoken line will synchronize perfectly. Review dialogue, background sound and the speaker's identity before use.

Vidu's release notice describes faster creation, lower costs and improved performances. Those are manufacturer claims. We have no independent Q4 speed, quality or cost benchmark and do not promise a turnaround time.

## How to try Vidu Q4 Preview

1. Open [Vidu's official Q4 page](https://www.vidu.com/vidu-q4) and follow its generation entry. Check access and the exact model shown in your account.
2. Choose image-to-video for one starting frame, or reference-to-video for a scene built from multiple assets. Upload material you have permission to use.
3. Write a compact scene instruction: subject, action, camera movement, then sound. Keep the first attempt focused on one shot.
4. Review the available duration, resolution, audio option and total charge in Vidu before submitting. Do not assume a promotional rate or a free allowance applies to your account.
5. Inspect the finished clip for geometry, text, faces, motion and dialogue. Download a result you need to keep; the API's returned creation links are documented as valid for 24 hours.

The last step matters for product work: a visually attractive clip can still alter a handle, logo or label. Compare the result with the reference rather than treating a successful generation as acceptance of every detail.

## Vidu Q4 Preview pricing

The [official API pricing page](https://platform.vidu.com/docs/overview/pricing), checked October 11, 2026, lists the following Q4 credit consumption for image-to-video and reference-to-video:

| Resolution | Vidu API credits per second | Five-second example |
| --- | --- | --- |
| 540p | 9 | 45 Vidu API credits |
| 720p | 19 | 95 Vidu API credits |
| 1080p | 24 | 120 Vidu API credits |
| 2K | 38 | 190 Vidu API credits |
| 4K | 78 | 390 Vidu API credits |

The five-second column is arithmetic using the published rate, not a paid test or a checkout quote. These are **Vidu API credits, not EzImageAI credits**. The pricing page also displays RMB-denominated credit packages; consumer subscriptions, regional offers and temporary promotions can use different terms. We cannot establish one universal USD price or free Q4 allowance from this information. Check the price in the Vidu service you intend to use, including duration, resolution and any current offer.

EzImageAI has no Q4 price or Q4 checkout. For the other video models available here, only the current EzImageAI quote applies; see [credits and billing](/docs/credits).

## API orientation for developers

The documented model identifier is **viduq4-preview**. Vidu publishes separate create-task endpoints for image-to-video at **/ent/v2/img2video** and reference-to-video at **/ent/v2/reference2video**, on **api.vidu.com**. Successful submission returns a task identity; the result must be retrieved when processing completes.

Use the linked endpoint documentation for the full request contract. The current image-input type label and example disagree, and authentication examples differ between create and query sections. We have not validated a runnable request, so this guide does not provide copy-and-run API code. Confirm these details with Vidu before building production submission and recovery logic.

An official API's existence does not mean a separate service has integrated that model. This article adds no Q4 API connection to EzImageAI.

## Q4 Preview, Vidu Q3 and EzImageAI's current models

This is a workflow comparison based on documentation, not a ranking from generated samples.

| Choice | Useful distinction | Where to check availability |
| --- | --- | --- |
| Vidu Q4 Preview | Image and reference workflows, optional voice references, output options up to 4K | Vidu's official service and Q4 API documents |
| Vidu Q3 Pro or Turbo | A separate text-to-video endpoint supports prompts without a starting image | [Vidu Q3 text-to-video documentation](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video) |
| EzImageAI's current video models | Text or one reference image, with settings and costs determined by the selected available model | [EzImageAI video editor — other models](/create?mode=video) and [video guide](/docs/video-beta) |

EzImageAI's current video catalog includes models from Kling, Seedance, Veo, MiniMax and Gemini; live availability depends on service configuration and supported, priced settings. Ordinary video requires sign-in and enough available account credits, including valid gifted credits, with no guest video trial. The editor does not currently accept uploaded audio or multiple reference images for ordinary video. A Q4 voice-reference prompt below therefore belongs in a supporting Vidu workflow, not in an implied Q4 mode here.

## Three original prompts to adapt

These are **untested prompt ideas**, not generated examples or quality evidence. Copying the text is free; a generation can cost money in the service you choose. Match each idea to its required inputs.

### Ceramic cup: one starting image

\`\`\`prompt
Use the supplied product photograph as the starting frame. Keep the ceramic cup's shape, handle and glaze recognizable. Over a short continuous shot, slowly push the camera toward the cup on the wooden table as a small curl of steam rises. Soft window light, stable background, no new objects, captions or scene cuts. Silent output.
\`\`\`

The single camera move gives you one thing to evaluate. Turn off generated audio in the interface, or set the API audio option to false, for this silent example; the prompt alone is not the audio control. Check the cup's outline and handle against the source; the instruction does not guarantee preservation.

### Cafe greeting: character and setting references

\`\`\`prompt
Use the first image for the consenting adult character and the second for the cafe setting. Seat the character beside the window. In one medium shot, the character gives a small wave and says, "Good to see you." Keep the camera steady and the face unobstructed. Quiet cafe ambience; no background music, extra speakers, captions or cuts. If an authorized voice reference is supplied, use it for this speaker.
\`\`\`

Keep the line short so it fits the shot. Only supply a voice recording whose use is authorized; check the spoken words and timing afterward.

### Running shoe: product and location references

\`\`\`prompt
Use the product image for the shoe design and the location image for the wet pavement. Show one runner's feet moving through a shallow puddle in a low side-tracking shot. Keep the shoe color and silhouette recognizable. Small water splashes, overcast daylight, one continuous action, no added logos or captions. Natural footsteps and water sounds, no music or dialogue.
\`\`\`

Start by evaluating one stride and one splash. Faster movement makes product shape and repeated details worth checking frame by frame; we have not tested this prompt's fidelity.

## Plan your next step

For Q4-specific references and sound, [try the official Vidu Q4 service](https://www.vidu.com/vidu-q4) and verify your account's controls and price. For a video with a model already offered here, [open EzImageAI's video editor for other models](/create?mode=video). You can also [prepare a source image](/image-to-image) or read our [prompt-writing guide](/blog/ai-image-editing-prompts) before choosing a video workflow.`,
	},
] as const satisfies readonly BlogPost[];
