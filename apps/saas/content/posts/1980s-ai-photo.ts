import type { BlogPost } from "../../modules/public-content/lib/blog-types";
import { PHOTO_IDEA_RECIPE_ROUTES } from "../../modules/public-content/lib/photo-idea-routes";

export const eightiesPhotoDocuments = [
	{
		...PHOTO_IDEA_RECIPE_ROUTES[0],
		id: "1980s-ai-photo",
		locale: "en",
		title: "1980s AI Photo Ideas & Prompts",
		description:
			"Three ways to give a portrait an 80s-inspired look: a studio portrait, a warm family-album snapshot, or a late-afternoon street photo. Compare the originals, copy a complete prompt, or try a style with your own photo here.",
		publishedAt: "2026-09-29",
		updatedAt: "2026-10-04",
		articleType: "photo-ideas",
		categoryId: "photo-ideas",
		tags: ["portrait", "retro", "1980s", "photo ideas"],
		authorId: "ezimageai-editorial",
		featuredOrder: 1,
		primaryEffectId: "1980s-ai-photo",
		recipePlacement: {
			presetsAfterHeadingId: "choose-a-direction-for-your-portrait",
			editorAfterHeadingId: "prepare-your-own-photo",
		},
		relatedEffectIds: ["1980s-ai-photo"],
		published: true,
		body: `An 80s photo can mean a carefully lit studio portrait, a slightly faded print from a family album, or a casual snapshot outdoors. The clothes, lighting, setting, and print texture do more to distinguish these looks than adding a generic vintage filter.

The three ideas below start with the same AI-generated fictional adult. Each pairs the original with an actual EzImageAI output and the exact prompt used for that result. Pick the direction that suits your photo; copying a prompt or choosing a style does not start a generation.

## Choose a direction for your portrait

Start with the setting you want: a composed studio portrait, a warm living-room snapshot, or a casual street scene. Each comparison shows both what worked in that run and what changed from the reference. The full prompts are available under each example.

## Prepare your own photo

Choose a clear, well-lit portrait you have permission to edit. One visible face and shoulders, with some space above the head, are closest to the reference used here. Children, groups, hands, obscured faces, and full-body photographs were not tested.

After selecting a style, upload your own photo and review the prompt and current settings. The editor shows model availability, account or guest eligibility, and the current credit quote. Generate only when those settings are right for you.

## Adjust the look and review the result

To experiment, change one styling detail at a time, such as the jacket, background, or strength of the film grain. These are suggestions to try, not tested guarantees. Return to the original image if successive edits move too far from the person or composition you want to keep.

Compare facial features, expression, apparent age, hair, and the crop with the original. The prompt asks the model to use the reference as a guide, but it cannot guarantee an identical face. These images are AI interpretations of a decade, not historical records.

## What the examples establish

Four product generations were reviewed on September 29, 2026, using Nano Banana 2 Lite at 1K. Three selected outputs are shown above with their matching prompt versions and aspect ratios. Their common original was created separately with an image model. The website images were resized or compressed without creative retouching.

The first family-album output had red-eye and an open smile. A revised prompt asked for off-axis bounced flash, natural brown eyes, and the same closed-mouth expression. The selected second output showed no obvious red-eye and a closed mouth. Several instructions changed together, so one comparison cannot tell us which change caused the improvement.

This is a small demonstration using one fictional adult, not a success-rate study or a test of identity preservation across different people. The article was reorganized on October 4, 2026; no new generations were performed for that update.

For general wording advice, see [how to write image editing prompts](/blog/ai-image-editing-prompts). The [private editing workflow](/blog/private-image-editing-workflow) explains how your own uploaded photos and results are handled.`,
	},
] as const satisfies readonly BlogPost[];
