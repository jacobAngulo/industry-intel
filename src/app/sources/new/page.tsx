import type { Metadata } from "next";
import Link from "next/link";

import { getActor } from "@/app/_lib/identity";
import { AddSourceWizard, type WizardSuggestion } from "@/components/sources/AddSourceWizard";
import { entriesFromParam, typeFromParam } from "@/components/sources/wizard-logic";
import { PageContainer, PageHeader } from "@/components/ui";
import { IDENTITY_FIELDS, parseConfig } from "@/lib/connectors/configs";
import { listFeeds, listSuggestions } from "@/lib/services";

import type { SearchParams } from "../query";

export const metadata: Metadata = { title: "Add a source" };

/** A suggestion config with the schema defaults, so that the form shows every option. */
function suggestionWithDefaults(s: WizardSuggestion): WizardSuggestion {
  try {
    return { ...s, config: parseConfig(s.type, s.config) };
  } catch {
    return s;
  }
}

export default async function NewSourcePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const forcedType = typeFromParam(params.type);
  const initialText = entriesFromParam(params.entries);
  const feedParam = Array.isArray(params.feed) ? params.feed[0] : params.feed;

  const [actor, feeds, suggestions] = await Promise.all([getActor(), listFeeds(), listSuggestions()]);
  const activeFeeds = feeds
    .filter((f) => !f.archived)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((f) => ({ id: f.id, slug: f.slug, name: f.name }));
  const preselected = activeFeeds.filter((f) => f.slug === feedParam || String(f.id) === feedParam).map((f) => f.id);
  const shownSuggestions = suggestions
    .filter((s) => !forcedType || s.type === forcedType)
    .map((s) =>
      suggestionWithDefaults({
        feedSlug: s.feedSlug,
        type: s.type,
        name: s.name,
        why: s.why,
        config: s.config,
        ...(s.url ? { url: s.url } : {}),
      }),
    );

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          <Link href="/sources" className="text-muted underline hover:text-fg">
            Sources
          </Link>
        }
        title="Add a source"
        description="Paste a link, enter a sender, or describe a topic. You see recent items before anything is added."
      />
      <AddSourceWizard
        initialText={initialText}
        initialType={forcedType}
        feeds={activeFeeds}
        preselectedFeedIds={preselected}
        suggestions={shownSuggestions}
        identityFields={IDENTITY_FIELDS}
        displayName={actor.name}
      />
    </PageContainer>
  );
}
