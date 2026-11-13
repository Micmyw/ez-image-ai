import { MINIMAX_H3_EXAMPLES } from "./minimax-h3-examples";
import { SEEDREAM_5_5_EXAMPLES } from "./seedream-5-5-examples";

export type ImageToolPageKey =
	| "minimax-h3-image"
	| "seedream-5-5"
	| "gpt-image-2-6"
	| "ai-svg-generator"
	| "ai-gif-generator";

export interface ImageToolExampleImage {
	src: string;
	alt: string;
	width: number;
	height: number;
}

export interface ImageToolPageContent {
	path: `/${ImageToolPageKey}`;
	title: string;
	description: string;
	heading: string;
	modelName?: string;
	intro: string;
	facts: readonly string[];
	settingsNote: string;
	sections: readonly { id: string; title: string; body: string }[];
	steps: readonly { title: string; body: string }[];
	showPassOffer?: boolean;
	showAvailabilityNote?: boolean;
	promptSource?: { label: string; href: string };
	prompts: readonly {
		title: string;
		prompt: string;
		resolution?: string;
		image?: ImageToolExampleImage;
		referenceImage?: ImageToolExampleImage;
	}[];
	faq: readonly { question: string; answer: string }[];
}

const creditFaq = {
	question: "How are generations charged?",
	answer:
		"Choose account credits or an eligible image pass, then check the cost before generating. The $2.99 pack includes 3 successful results, with no subscription required when paying with these passes. Credit-funded requests retain their account and subscription requirements. Each new generation or edit has its own quote.",
};
const imagePassFaq = {
	question: "Does the $2.99 pack cover GPT Image 2.6, SVG and GIF?",
	answer:
		"Yes. Both new purchases and remaining uses from existing $2.99 packs cover GPT Image 2.6 Flare and Sunburst: PNG or JPEG at 1K, 2K or 4K, static SVG, and GIF with 2–16 frames. One successful result uses one pass, including a whole GIF regardless of its frame count. Choose Image pass as the payment source; buying a pack does not automatically switch your selection. Earlier packs sold for a different price keep their original terms.",
};
const privacyFaq = {
	question: "Are my uploads and results public?",
	answer:
		"Your reference images and results use the private EzImageAI workspace. They are not automatically published in a public gallery. Upload only material you have permission to use, and follow the content safety and usage rules shown in the editor.",
};

export const IMAGE_TOOL_PAGES: Record<ImageToolPageKey, ImageToolPageContent> = {
	"seedream-5-5": {
		path: "/seedream-5-5",
		title: "Seedream 5.5 — AI Image Generator & Precise Photo Editor",
		description:
			"Create realistic images, crisp poster text and transparent PNGs with Seedream 5.5. Edit a reference photo, explore examples and try their prompts at 1K, 1.5K or 2K.",
		heading: "Seedream 5.5",
		modelName: "Seedream 5.5",
		intro:
			"Create lifelike scenes, expressive typography and transparent design assets. Or take a photo in a new direction.",
		facts: ["Precise photo editing", "Native transparent PNG", "1K · 1.5K · 2K"],
		settingsNote:
			"1K: 8 credits · 1.5K: 12 credits · 2K: 20 credits. PNG or JPEG, with one optional reference photo.",
		showPassOffer: false,
		showAvailabilityNote: false,
		sections: [
			{
				id: "precise-photo-edits",
				title: "Keep refining the same image",
				body: "Change the setting, adjust a small detail or try a different material. Seedream 5.5 is designed to keep the surrounding image consistent across edits. Continue with your result to build on the last version.",
			},
			{
				id: "transparent-design-assets",
				title: "Make room for your design",
				body: "Choose Transparent to create a PNG with an alpha channel. Make cutout products, stickers, characters and lettering that can sit naturally in your next layout.",
			},
			{
				id: "realism-and-lettering",
				title: "Bring texture and type together",
				body: "Describe the light, surface and composition for a believable scene. For posters and infographics, include the exact words and a clear hierarchy to guide the layout.",
			},
		],
		steps: [
			{
				title: "Start with an idea",
				body: "Write a prompt or choose an example. Add a reference photo when you want to edit an existing image.",
			},
			{
				title: "Choose the finish",
				body: "Select 1K, 1.5K or 2K. Use PNG for transparency, or JPEG for a photograph with a solid background.",
			},
			{
				title: "Create, refine, download",
				body: "Generate your image, continue editing from the result, and download the version you like.",
			},
		],
		promptSource: { label: "Kie", href: "https://kie.ai/seedream-5-5" },
		prompts: SEEDREAM_5_5_EXAMPLES,
		faq: [
			{
				question: "What is new in Seedream 5.5?",
				answer:
					"Seedream 5.5 focuses on more consistent edits, native transparent backgrounds, realistic lighting and materials, and clearer written text. Use it for photography, product images, posters, infographics and reusable design assets.",
			},
			{
				question: "Can I edit the same photo again?",
				answer:
					"Yes. Upload a reference photo and describe what to change. You can then continue editing from your result, keeping each version in your workspace.",
			},
			{
				question: "How do I make a transparent image?",
				answer:
					"Choose Transparent in the background settings. PNG is selected automatically so the downloaded image can retain its transparency.",
			},
			{
				question: "How many credits does an image use?",
				answer:
					"1K uses 8 credits, 1.5K uses 12, and 2K uses 20. The same prices cover text-to-image generation and editing with one reference photo. Seedream 5.5 uses account credits with an active paid subscription.",
			},
			{
				question: "Which reference files can I use?",
				answer:
					"Upload one PNG, JPEG or WebP image up to 10 MB. Each generation produces one image, downloadable as PNG or JPEG from your private workspace.",
			},
		],
	},
	"minimax-h3-image": {
		path: "/minimax-h3-image",
		title: "MiniMax H3 Image — AI Image Generator & Photo Editor",
		description:
			"Create detailed images and edit photos with MiniMax H3 Image. Explore real examples, try their prompts, choose 1K, 2K or 4K, and download PNG or JPEG images.",
		heading: "MiniMax H3 Image",
		modelName: "MiniMax H3 Image",
		intro:
			"Turn a prompt into a detailed image, or give a photo a new look. Create product shots, posters and illustrated guides in one workspace.",
		facts: ["Text to image & photo editing", "1K · 2K · 4K", "From 5 credits"],
		settingsNote: "1K: 5 credits · 2K: 10 credits · 4K: 20 credits. Download as PNG or JPEG.",
		showPassOffer: false,
		showAvailabilityNote: false,
		sections: [
			{
				id: "detailed-images",
				title: "Give texture and detail room to shine",
				body: "Describe the materials, lighting and arrangement for product photography, still life or a scene of your own. Choose 4K when you want a larger image with room for fine detail.",
			},
			{
				id: "posters-and-guides",
				title: "Build a poster or explain an idea",
				body: "Combine illustration, a clear layout and exact lettering in one prompt. Make a festival poster, an editorial graphic or a step-by-step visual guide.",
			},
			{
				id: "photo-editing",
				title: "Change the light, the look or the atmosphere",
				body: "Add a reference photo and describe your edit. Turn afternoon into evening, change an outfit or explore a new setting while specifying the details you want to keep.",
			},
		],
		steps: [
			{
				title: "Describe your image",
				body: "Write a prompt, or use one of the examples above as your starting point.",
			},
			{
				title: "Choose your settings",
				body: "Add an optional reference photo, then choose 1K, 2K or 4K and PNG or JPEG.",
			},
			{
				title: "Create and download",
				body: "Check the credit cost, generate your image and download it from your workspace.",
			},
		],
		promptSource: { label: "Kie", href: "https://kie.ai/minimax-h3-image" },
		prompts: MINIMAX_H3_EXAMPLES,
		faq: [
			{
				question: "What can I create with MiniMax H3 Image?",
				answer:
					"Create images from text or edit a reference photo. MiniMax H3 Image works with product shots, posters, illustrations, infographics and realistic scenes, with 1K, 2K and 4K output options.",
			},
			{
				question: "Can I try MiniMax H3 Image for free?",
				answer:
					"Eligible registered accounts receive 10 one-time credits, enough for two MiniMax H3 Image 1K generations at 5 credits each. MiniMax H3 Image 1K is the default model for the free plan. There is no monthly refill; 2K and 4K require a paid subscription.",
			},
			{
				question: "How many credits does each image use?",
				answer:
					"A 1K image uses 5 credits, 2K uses 10 and 4K uses 20. These prices apply to text-to-image generation and an edit with one reference photo.",
			},
			{
				question: "How do I edit a photo?",
				answer:
					"Upload one reference image and describe what you want to change. You can use PNG, JPEG or WebP. Keep the file within the upload limit shown in your workspace, up to 20 MB for this model.",
			},
			{
				question: "Which image formats can I download?",
				answer:
					"Choose PNG or JPEG before generating. Each request produces one image, available in your private workspace and history.",
			},
		],
	},
	"gpt-image-2-6": {
		path: "/gpt-image-2-6",
		title: "GPT Image 2.6 — Flare & Sunburst AI Image Generator",
		description:
			"Create with GPT Image 2.6: choose Flare for speed or Sunburst for detail. Try gpt-image-2.6 image generation, reference edits, static SVG and short GIFs.",
		heading: "GPT Image 2.6",
		intro:
			"Choose Flare for a quick creative direction or Sunburst for detailed work. Describe your image, add an optional reference, and create in the workspace below.",
		facts: ["Text or photo input", "Flare & Sunburst", "Images, SVG & GIF"],
		settingsNote:
			"Raster images offer 1K, 2K and 4K tiers. SVG and GIF use the 1K selection; GIF frames are 512 × 512 pixels. Flare uses medium quality and Sunburst uses high quality in this first version.",
		sections: [
			{
				id: "flare",
				title: "GPT Image 2.6 Flare: start with speed",
				body: "Flare is the speed-focused version of GPT Image 2.6. Use it to explore a composition, draft a poster, or try several product-image directions. Describe the layout, lighting and exact wording you want, then review the result before choosing your next edit.",
			},
			{
				id: "sunburst",
				title: "GPT Image 2.6 Sunburst: refine the details",
				body: "Sunburst is designed for detailed output and consistency across edits. Use it when material, composition or reference details need closer attention. Name what should stay the same and make one deliberate change per edit; check faces, lettering and small objects in every result.",
			},
			{
				id: "formats",
				title: "Choose the file your project needs",
				body: "Use PNG or JPEG for conventional image workflows, static SVG for scalable illustrations, or GIF for a short animated loop. The format controls show the available choices for your selected model and size. SVG and GIF are generated through the model; renaming a PNG file is not part of this workflow.",
			},
		],
		steps: [
			{ title: "Choose a model", body: "Start with Flare, or select Sunburst for detailed work." },
			{
				title: "Write your brief",
				body: "Describe the subject and layout. Add a photo when an existing reference matters.",
			},
			{
				title: "Review and download",
				body: "Check the settings and your selected credit or pass cost, generate, then preview and download your result.",
			},
		],
		prompts: [
			{
				title: "A structured product image",
				prompt:
					"A studio product image of a matte terracotta ceramic mug on a warm cream surface. Keep the mug in the left third, a soft shadow below, and clean negative space on the right. Soft window light, visible ceramic texture, no text.",
			},
			{
				title: "A considered poster layout",
				prompt:
					'Create a minimal botanical exhibition poster. Put the exact headline "GROW SLOW" at the top, a single large fern in the center and the small text "SATURDAY 10 AM" at the bottom. Deep green and warm ivory, clear spacing, restrained typography.',
			},
		],
		faq: [
			{
				question: "What is GPT Image 2.6?",
				answer:
					"GPT Image 2.6 is OpenAI's image model release with Flare and Sunburst variants. EzImageAI brings these choices into its existing image workspace for prompt-based creation and reference-guided editing, with PNG, JPEG, static SVG and GIF output options.",
			},
			{
				question: "Should I choose Flare or Sunburst?",
				answer:
					"Choose Flare for speed-focused exploration and Sunburst for detailed output and consistency across revisions. This version uses medium quality for Flare and high quality for Sunburst. Actual completion time and quality depend on your request and service availability.",
			},
			{
				question: "Can I edit an existing image with gpt-image-2.6?",
				answer:
					"Yes. Add a reference photo to the composer and describe what to change and what to keep. Leave the reference empty for text-to-image generation. The editor currently accepts one reference image per request.",
			},
			{
				question: "Can GPT Image 2.6 generate SVG and GIF files?",
				answer:
					"Yes. Choose SVG for a static illustration or GIF for an animation with 2–16 frames. This version uses 512 × 512 pixels per GIF frame. Select the 1K output tier to access these formats; the separate SVG and GIF pages open the same workspace with the relevant format selected.",
			},
			creditFaq,
			imagePassFaq,
			privacyFaq,
		],
	},
	"ai-svg-generator": {
		path: "/ai-svg-generator",
		title: "AI SVG Generator — Create SVG Illustrations from Text",
		description:
			"Use the AI SVG generator to turn a prompt into a static SVG illustration. Preview and download scalable artwork for websites, apps and print projects.",
		heading: "AI SVG Generator",
		intro:
			"Describe an illustration and generate a static SVG you can preview and download. Start with a clear subject, a small color palette and the space where your design will live.",
		facts: ["Text to SVG", "Static .svg download", "Web, app & print projects"],
		settingsNote:
			"SVG is selected for you with the 1K generation tier. The downloaded .svg is a static design. Review the file in your design software before production use.",
		sections: [
			{
				id: "text-to-svg",
				title: "Text to SVG AI: describe the illustration",
				body: "Write the subject, composition, colors and intended use in ordinary language. For a clean result, ask for simple shapes, clear outlines and a limited palette. Generate an SVG directly from the prompt, then open the file in your vector design software to inspect and refine the artwork.",
			},
			{
				id: "website-illustrations",
				title: "SVG illustrations for websites and apps",
				body: "Create a hero illustration, an onboarding scene or an empty-state graphic. Describe the surrounding interface and leave space where headings or buttons will sit. Check the illustration at the smallest size where it will appear, and add accessible alternative text when you publish it.",
			},
			{
				id: "vector-art",
				title: "An AI vector illustration generator for print ideas",
				body: "Explore printable vector art for a poster, card or decorative composition. SVG can scale its vector elements without a fixed pixel grid. Check lettering, shapes, stroke widths and color requirements in your design application; a generated SVG is not automatically a press-ready file.",
			},
			{
				id: "editing-svg",
				title: "From a prompt to an editable SVG",
				body: "Download the .svg and inspect its structure in an SVG-compatible editor. Grouping and path complexity vary by result. Lettering is saved as vector paths, so you can adjust its shapes but cannot edit it as font-based text. Start with a simple composition when you expect to adjust individual shapes, and regenerate with a narrower brief if the first design is too complex.",
			},
		],
		steps: [
			{
				title: "Describe the artwork",
				body: "Name the subject, visual style, palette and intended layout. Keep the initial brief simple.",
			},
			{
				title: "Generate an SVG",
				body: "Keep SVG selected, review the credit or pass cost and generate with Flare or Sunburst.",
			},
			{
				title: "Preview and download",
				body: "Inspect the result, download .svg and make final adjustments in your design software.",
			},
		],
		prompts: [
			{
				title: "Website hero illustration",
				prompt:
					"A simple flat vector illustration of a small greenhouse with three leafy plants. Rounded geometric shapes, forest green, terracotta and warm cream. Put the greenhouse on the right with open space on the left for a website headline. No text, no gradients, crisp paths.",
			},
			{
				title: "App onboarding scene",
				prompt:
					"A clean vector illustration for a reading app onboarding screen: an open book, a cup and a small plant arranged in a balanced square composition. Three flat colors, consistent outlines, generous spacing, no text and no tiny decorative details.",
			},
			{
				title: "Printable botanical art",
				prompt:
					"A static vector botanical composition of three stylized wildflowers, designed for a greeting card. Broad simple shapes, two spot-like colors, white background, consistent medium-weight stems, no texture, no lettering, ample margins.",
			},
		],
		faq: [
			{
				question: "What does this AI SVG generator produce?",
				answer:
					"It generates a static SVG from your prompt using GPT Image 2.6. You can preview the result and download an .svg file. This is a generation workflow, not a PNG-to-SVG tracing or conversion tool.",
			},
			{
				question: "Can I edit the generated SVG?",
				answer:
					"You can open the downloaded file in SVG-compatible design software. The number of paths and grouping vary with the result, so inspect the file before planning detailed edits. Lettering is saved as vector paths and cannot be edited as font-based text. Simpler prompts usually make the structure easier to work with.",
			},
			{
				question: "Can I use the SVG on a website or in an app?",
				answer:
					"Yes, a static SVG can be used as an illustration in a web or app project. Preview it at your target dimensions, check file size and color contrast, and provide appropriate alternative text. Review rights and the final design before publishing.",
			},
			{
				question: "Is an AI-generated SVG ready for printing?",
				answer:
					"SVG is useful for scalable artwork, but print production still needs a file check. Confirm text, line weights, dimensions, color handling and your printer's accepted formats. Add bleed or convert to the requested print format in your design application when needed.",
			},
			{
				question: "Can I make an animated SVG?",
				answer:
					"This tool generates static SVG only. For a short animation, use the AI GIF Generator, which offers 2–16 frames with GPT Image 2.6.",
			},
			creditFaq,
			imagePassFaq,
			privacyFaq,
		],
	},
	"ai-gif-generator": {
		path: "/ai-gif-generator",
		title: "AI GIF Generator & Creator — Text or Photo to GIF",
		description:
			"Create short animations with the AI GIF generator. Turn text or a photo into a GIF, choose 2–16 frames, preview the animation and download your file.",
		heading: "AI GIF Generator",
		intro:
			"Turn an idea or a reference photo into a short animated GIF. Describe one clear movement, choose the frame count, and preview the finished animation in your workspace.",
		facts: ["Text or photo to GIF", "2–16 frames", "512 × 512 pixels per frame"],
		settingsNote:
			"GIF is selected for you. Choose 2–16 frames and a frame duration from 20 to 2,000 milliseconds. More frames change the motion and credit quote; with an eligible $2.99 pack, one successful GIF uses one pass. This version does not offer 64-frame GIFs.",
		sections: [
			{
				id: "text-to-gif",
				title: "An AI GIF creator that starts with a sentence",
				body: "Describe the subject, one action and the background. A waving flag, a gently opening flower or a rotating object gives a short animation a clear purpose. Ask for a fixed camera and a stable backdrop when the movement should be easy to follow.",
			},
			{
				id: "photo-to-gif",
				title: "Create a GIF from a reference photo",
				body: "Add a photo to guide the subject and appearance, then say which part should move. Keep the motion modest when a face, product or composition needs to remain recognizable. Review every part of the animation; reference fidelity and a seamless loop are not guaranteed.",
			},
			{
				id: "gif-timing",
				title: "Choose the frames and timing for your loop",
				body: "Frame count and frame duration work together. Nine frames at 200 milliseconds each make a 1.8-second sequence. More frames can describe more stages of movement; a longer frame duration slows playback. Start small and preview the result before generating another version.",
			},
		],
		steps: [
			{
				title: "Describe one movement",
				body: "Write a motion prompt, with an optional reference photo to guide the appearance.",
			},
			{
				title: "Set frames and timing",
				body: "Choose 2–16 frames, set the frame duration and review the credit or pass cost.",
			},
			{
				title: "Play and download",
				body: "Preview the completed animation in your workspace, then download the .gif file.",
			},
		],
		prompts: [
			{
				title: "A simple animated loop",
				prompt:
					"A tiny red paper boat gently rocking on calm blue water, fixed camera and a clean simple background. One small repeating motion, smooth transitions, consistent boat shape, no text. Aim for a looping animation.",
			},
			{
				title: "Bring a product photo to life",
				prompt:
					"Use the reference photo as the subject. Keep the product shape and colors consistent while a soft highlight moves slowly across its surface. Fixed camera, steady background, subtle motion, no added text.",
			},
		],
		faq: [
			{
				question: "How do I make a GIF with AI?",
				answer:
					"Describe the scene and one movement, keep GIF selected, choose the frame count and duration, and generate. Once processing finishes, preview the animation and download the GIF from your private workspace.",
			},
			{
				question: "Can this AI GIF creator animate a photo?",
				answer:
					"Yes. Add a reference photo and describe the intended motion. This guides the output rather than guaranteeing an exact frame-by-frame match to the original. Review the subject and the full animation before using it.",
			},
			{
				question: "How many GIF frames can I generate?",
				answer:
					"This version supports 2–16 frames with GPT Image 2.6 Flare and Sunburst, at 512 × 512 pixels per frame. A 64-frame option is not available in this workspace. The frame controls enforce the supported limits.",
			},
			{
				question: "How long will my GIF last?",
				answer:
					"Multiply the number of frames by the frame duration. For example, 9 frames at 200 milliseconds each make a 1.8-second sequence. Frame durations are set in 10-millisecond increments from 20 to 2,000 milliseconds; playback can vary between viewers.",
			},
			{
				question: "Will the animation loop seamlessly?",
				answer:
					"A prompt can request a loop, but a seamless transition is not guaranteed. Keep the movement simple and the camera fixed, and inspect the last-to-first-frame transition before sharing.",
			},
			creditFaq,
			imagePassFaq,
			privacyFaq,
		],
	},
};

export function imageToolStructuredData(content: ImageToolPageContent, baseUrl: string) {
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				"@id": new URL(content.path, baseUrl).href,
				name: content.title,
				description: content.description,
				inLanguage: "en",
			},
			{
				"@type": "FAQPage",
				mainEntity: content.faq.map(({ question, answer }) => ({
					"@type": "Question",
					name: question,
					acceptedAnswer: { "@type": "Answer", text: answer },
				})),
			},
		],
	};
}
