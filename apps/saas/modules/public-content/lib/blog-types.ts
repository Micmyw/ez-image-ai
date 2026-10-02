export const BLOG_CATEGORIES = ["prompt-writing", "privacy-workflow"] as const;
export type BlogCategoryId = (typeof BLOG_CATEGORIES)[number];
export type BlogArticleType = "guides" | "prompt-guides" | "troubleshooting" | "comparisons";

export const BLOG_EDITORIAL_TEAM = {
	id: "ezimageai-editorial",
	name: "EzImageAI Editorial Team",
	type: "Organization",
} as const;

export type BlogPresetReference = {
	effectId: string;
	presetId: string;
};

export type BlogContentBlock = (
	| (BlogPresetReference & { type: "effect" | "preset-prompt" })
	| { type: "before-after"; effectId: string; exampleId: string }
) & {
	/** Insert after this section, using the same stable ID as the heading/TOC. */
	afterHeadingId: string;
};

export type BlogPost = {
	id: string;
	slug: string;
	locale: string;
	title: string;
	description: string;
	publishedAt: string;
	updatedAt?: string;
	articleType: BlogArticleType;
	categoryId: BlogCategoryId;
	tags: readonly string[];
	authorId: typeof BLOG_EDITORIAL_TEAM.id;
	cover?: { src: string; alt: string; width: number; height: number };
	primaryEffectId?: string;
	/** The single maintained source of article-to-effect relationships. */
	relatedEffectIds: readonly string[];
	contentBlocks?: readonly BlogContentBlock[];
	sources?: readonly { title: string; url: string; accessedAt?: string }[];
	tests?: readonly {
		testedAt: string;
		context: string;
		result: string;
		preset?: BlogPresetReference;
	}[];
	published: boolean;
	body: string;
};

export type BlogCardContent = Pick<
	BlogPost,
	"id" | "slug" | "title" | "description" | "categoryId" | "tags" | "cover"
> & {
	date: string;
	dateLabel: string;
	readingMinutes: number;
};

export function blogPath(post: Pick<BlogPost, "slug">): string {
	return `/blog/${post.slug}`;
}
