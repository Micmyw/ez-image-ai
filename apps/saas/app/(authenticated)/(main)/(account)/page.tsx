import { redirect } from "next/navigation";

export default async function AppStartPage() {
	redirect("/create");
}
