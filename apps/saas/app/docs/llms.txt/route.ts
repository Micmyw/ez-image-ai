import { source } from "@docs/lib/source";

export const revalidate = false;

export async function GET() {
	const lines = ["# EzPic documentation", ""];
	for (const page of source.getPages()) {
		lines.push(`- [${page.data.title}](${page.url}): ${page.data.description}`);
	}

	return new Response(lines.join("\n"), {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
