import { getLLMText, source } from "@docs/lib/source";
import { notFound } from "next/navigation";

export const revalidate = false;

export async function GET(
	_request: Request,
	{ params }: RouteContext<"/docs/llms.mdx/[[...slug]]">,
) {
	const { slug } = await params;
	const page = source.getPage(slug);
	if (!page) notFound();

	return new Response(await getLLMText(page), {
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
	});
}

export function generateStaticParams() {
	return source.generateParams();
}
