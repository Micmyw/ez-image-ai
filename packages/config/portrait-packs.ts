export const PORTRAIT_PACK_PATH = "/portrait-packs";
export const PORTRAIT_PACK_SIZE = 5;
export const PORTRAIT_PACK_TRIAL_LIMIT = 2;
export const PORTRAIT_PACK_STYLES = ["playful", "evening", "resort"] as const;

// Keep the v1 pool stable for request replay and saved trial packs.
export const PORTRAIT_PACK_CARDS = {
	"cobalt-gallery": { title: "Cobalt Gallery", color: "#b3c2ff", style: "evening" },
	"champagne-room": { title: "Champagne Room", color: "#ffda99", style: "evening" },
	"raspberry-satin": { title: "Raspberry Satin", color: "#ffc2cf", style: "evening" },
	"noir-studio": { title: "Noir Studio", color: "#e5d9e7", style: "evening" },
	"emerald-skyline": { title: "Emerald Skyline", color: "#b3e3cb", style: "evening" },
	"ivory-sunset": { title: "Ivory Sunset", color: "#ffd4a8", style: "evening" },
	"orchid-studio": { title: "Orchid Studio", color: "#e6bdff", style: "evening" },
	"velvet-gala": { title: "Velvet Gala", color: "#ecb4a6", style: "evening" },
	"cyan-rain": { title: "Cyan Rain", color: "#adedf4", style: "evening" },
	"red-carpet": { title: "Red Carpet", color: "#f9afa5", style: "evening" },
	sunhat: { title: "Sunhat", color: "#ffd690", style: "resort" },
	lobby: { title: "The Lobby", color: "#efe0c3", style: "evening" },
	poolside: { title: "Poolside", color: "#adeddc", style: "resort" },
	"gallery-steps": { title: "Gallery Steps", color: "#fbe496", style: "evening" },
	"surf-club": { title: "Surf Club", color: "#b6daff", style: "resort" },
	"emerald-stairs": { title: "Emerald Stairs", color: "#bee0bd", style: "evening" },
	"disco-silver": { title: "Disco Silver", color: "#d0c4ff", style: "evening" },
	"golden-coast": { title: "Golden Coast", color: "#ffc090", style: "resort" },
	"satin-wink": { title: "Satin Wink", color: "#b9d5ed", style: "playful", fullLength: true },
	"lilac-flash": { title: "Lilac Flash", color: "#e3bde8", style: "playful", fullLength: true },
	"cherry-lounge": { title: "Cherry Lounge", color: "#fdafb5", style: "playful", fullLength: true },
	"deco-steps": { title: "Deco Steps", color: "#e8ccac", style: "evening" },
	"plum-premiere": { title: "Plum Premiere", color: "#e1aecf", style: "evening" },
	"scarlet-lounge": { title: "Scarlet Lounge", color: "#f3ac99", style: "evening" },
	"cabana-blue": { title: "Cabana Blue", color: "#a9cafa", style: "resort" },
	"pool-ladder": { title: "Pool Ladder", color: "#a7e4d4", style: "resort" },
	"sunset-surf": { title: "Sunset Surf", color: "#eed2b1", style: "resort" },
	"marble-glance": { title: "Marble Glance", color: "#b1eced", style: "playful" },
	"golden-spin": { title: "Golden Spin", color: "#fbe1af", style: "playful" },
	"sapphire-steps": { title: "Sapphire Steps", color: "#c0cbff", style: "evening" },
	"atrium-rose": { title: "Atrium Rose", color: "#f5bdc8", style: "evening" },
	"emerald-greeting": { title: "Emerald Greeting", color: "#b4e1cc", style: "evening" },
	"velvet-seat": { title: "Velvet Seat", color: "#cbd3e9", style: "evening" },
	"violet-flash": { title: "Violet Flash", color: "#e2bafb", style: "playful" },
	"coral-runway": { title: "Coral Runway", color: "#ffc9ac", style: "evening" },
	"hotel-red": { title: "Hotel Red", color: "#f8adb2", style: "evening" },
} as const;

export type PortraitCardKey = keyof typeof PORTRAIT_PACK_CARDS;
export const PORTRAIT_CARD_KEYS = Object.keys(PORTRAIT_PACK_CARDS) as PortraitCardKey[];
