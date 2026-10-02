export const COLORING_PATH = "/photo-to-coloring-page";
export const COLORING_TITLE = "Turn Photo into Coloring Page";
export const COLORING_DESCRIPTION =
	"Turn your own photo into a coloring page with AI. Choose simple or detailed outlines, simplify the background, then download and print on A4 or US Letter.";

export const coloringSteps = [
	{
		title: "Upload your own photo",
		body: "Choose a clear JPG, PNG or WebP from your device. You can start with a pet, a portrait, a family picture or an object. You do not need an AI-generated image. Use a photo you own or have permission to edit.",
	},
	{
		title: "Choose how much detail to keep",
		body: "Select simple, balanced or detailed outlines. Choose a plain white background or a simplified version of the scene, then apply the settings. You can edit the instruction before generating.",
	},
	{
		title: "Generate and check the lines",
		body: "Review the selected model and credit cost, then start the edit. Check faces, hands, thin lines and enclosed areas before downloading. AI redraws the photo, so small details or likeness may change.",
	},
	{
		title: "Download, print or save a PDF",
		body: "Download your result or choose Print / Save PDF beside it. Select A4 or US Letter, match the paper size in the print dialog, turn off browser headers and footers, and choose a printer or Save as PDF. The image fits inside the page without cropping.",
	},
] as const;

export const coloringFaq = [
	{
		question: "Can I turn my own photo into a coloring page?",
		answer:
			"Yes. Upload a photo from your device and use it as the reference for the AI edit. You can convert existing photos directly; generating a new image first is not required. Your original file is not overwritten.",
	},
	{
		question: "How is a coloring page different from a black-and-white photo?",
		answer:
			"A grayscale photo keeps shadows and continuous tones. A coloring page uses outlines and empty white areas that you can fill in. This tool asks the model to redraw the subject as contour lines rather than simply remove the color.",
	},
	{
		question: "Can I simplify the image or remove the background?",
		answer:
			"Yes. Simple outlines request larger open shapes and fewer small details. Balanced and detailed outlines retain more contours. The plain white background option asks the AI to remove the scene around the main subject; results can still need another edit.",
	},
	{
		question: "Is the photo-to-coloring-page converter free?",
		answer:
			"It uses EzImageAI’s existing image-editing access and credit system. Guest availability, model access and the cost of the selected settings are shown in the editor. Printing an available image does not start another generation or spend generation credits.",
	},
	{
		question: "Can I print my coloring page or download a PDF?",
		answer:
			"Yes. Download the generated image, or use Print / Save PDF with A4 or US Letter. PDF saving uses your browser’s print dialog. Printing fits the existing image to the paper; it does not increase resolution or turn the image into an editable vector file.",
	},
	{
		question: "Which photos work best?",
		answer:
			"Choose a sharp photo with one clearly visible subject, good light and an uncluttered background. A close-up pet, a simple portrait or a single object is usually easier to color than a dark scene with many overlapping subjects. Crop unwanted objects from your source photo first.",
	},
	{
		question: "Will my photos appear in the public examples?",
		answer:
			"Uploads and generated outputs use the existing private image workflow and are not automatically added to this page. The dog shown here is an AI-generated demonstration, not a customer upload. Guest results are temporary; download them before the displayed expiry.",
	},
] as const;

export function coloringStructuredData(baseUrl: string) {
	const url = new URL(COLORING_PATH, baseUrl).href;
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebPage",
				"@id": `${url}#page`,
				url,
				name: COLORING_TITLE,
				description: COLORING_DESCRIPTION,
				inLanguage: "en",
				dateModified: "2026-10-03",
				mainEntity: { "@id": `${url}#tool` },
				primaryImageOfPage: {
					"@type": "ImageObject",
					contentUrl: new URL("/images/coloring/dog-coloring-page.webp", baseUrl).href,
					caption: "AI-generated illustration of a dog coloring page; demonstration only.",
				},
			},
			{
				"@type": "WebApplication",
				"@id": `${url}#tool`,
				name: "EzImageAI Photo to Coloring Page",
				url,
				applicationCategory: "DesignApplication",
				operatingSystem: "Web browser",
				description: COLORING_DESCRIPTION,
				featureList: [
					"Upload your own photo",
					"Simple, balanced or detailed outlines",
					"Plain white or simplified background",
					"Image download",
					"A4 and US Letter printing through the browser",
				],
				isPartOf: { "@type": "WebSite", name: "EzImageAI", url: baseUrl },
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: "EzImageAI", item: baseUrl },
					{ "@type": "ListItem", position: 2, name: "Photo to Coloring Page", item: url },
				],
			},
		],
	};
}
