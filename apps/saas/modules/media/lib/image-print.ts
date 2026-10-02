export type PrintPaper = "a4" | "letter";

/** CSS millimeters size the page, not the source image: printing never stretches or crops it. */
export function imagePrintStyles(paper: PrintPaper): string {
	const size =
		paper === "letter"
			? { width: 215.9, height: 279.4, name: "letter" }
			: { width: 210, height: 297, name: "A4" };
	return `@page { size: ${size.name} portrait; margin: 12mm; }
html, body { margin: 0; padding: 0; background: white; }
body { width: ${size.width - 24}mm; height: ${size.height - 24}mm; }
img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center; }`;
}

/** Only call with an authorized asset URL or a public example. No source is copied into public storage. */
export async function prepareImagePrint(url: string, paper: PrintPaper, title: string) {
	const parsed = new URL(url, window.location.origin);
	if (!["https:", "http:", "blob:"].includes(parsed.protocol)) throw new Error("Invalid image URL");
	const frame = document.createElement("iframe");
	frame.title = title;
	frame.setAttribute("aria-hidden", "true");
	frame.setAttribute("data-image-print", paper);
	frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;";
	document.body.append(frame);
	const dispose = () => frame.remove();
	try {
		const doc = frame.contentDocument;
		if (!doc || !frame.contentWindow) throw new Error("Print preview unavailable");
		doc.title = title;
		const style = doc.createElement("style");
		style.textContent = imagePrintStyles(paper);
		doc.head.append(style);
		const picture = doc.createElement("img");
		picture.alt = title;
		picture.referrerPolicy = "no-referrer";
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				picture.onload = null;
				picture.onerror = null;
				reject(new Error("Image load timed out"));
			}, 30_000);
			picture.onload = () => {
				window.clearTimeout(timer);
				resolve();
			};
			picture.onerror = () => {
				window.clearTimeout(timer);
				reject(new Error("Image unavailable"));
			};
			picture.src = parsed.href;
			doc.body.append(picture);
		});
		frame.contentWindow.addEventListener("afterprint", dispose, { once: true });
		return {
			dispose,
			print: () => {
				if (!frame.isConnected || !frame.contentWindow) throw new Error("Print preview closed");
				frame.contentWindow.focus();
				frame.contentWindow.print();
			},
		};
	} catch (error) {
		dispose();
		throw error;
	}
}
