import { redirect } from "next/navigation";

import { requireUser } from "@/app/_lib/identity";

/** `/f/[slug]/settings` opens the first group (§3). */
export default async function FeedSettingsPage({ params }: PageProps<"/f/[slug]/settings">) {
  await requireUser();
  const { slug } = await params;
  redirect(`/f/${encodeURIComponent(slug)}/settings/sources`);
}
