import { redirect } from "next/navigation";

/** `/f/[slug]/settings` opens the first group (§3). */
export default async function FeedSettingsPage({ params }: PageProps<"/f/[slug]/settings">) {
  const { slug } = await params;
  redirect(`/f/${encodeURIComponent(slug)}/settings/sources`);
}
