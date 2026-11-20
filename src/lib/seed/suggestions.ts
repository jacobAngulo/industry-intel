// The starter suggestions of specification §12: a static list. Nothing here
// is followed until a person clicks "Add" / "Use this". A suggestion whose
// key is in the directory does not show (see listSuggestions).
//
// `feedSlug` is the slug of the suggested feed (the seed makes the feeds
// "agentic-development", "internal-ai-platform", and "industry-radar").
// Each config must pass the configSchema of its type; fields that are absent
// take the schema defaults. The addresses were checked on 2026-11-19.
import type { Suggestion } from "@/lib/services/types";

export const SUGGESTION_FEED_SLUGS = {
  agenticDevelopment: "agentic-development",
  internalAiPlatform: "internal-ai-platform",
  industryRadar: "industry-radar",
} as const;

const { agenticDevelopment, internalAiPlatform, industryRadar } = SUGGESTION_FEED_SLUGS;

export const STARTER_SUGGESTIONS: readonly Suggestion[] = [
  {
    feedSlug: agenticDevelopment,
    type: "github",
    name: "Claude Code releases",
    why: "Releases of a coding agent that many teams use.",
    config: { owner: "anthropics", repo: "claude-code" },
    url: "https://github.com/anthropics/claude-code/releases",
  },
  {
    feedSlug: agenticDevelopment,
    type: "github",
    name: "OpenAI Codex releases",
    why: "Releases of the coding agent of OpenAI.",
    config: { owner: "openai", repo: "codex" },
    url: "https://github.com/openai/codex/releases",
  },
  {
    feedSlug: agenticDevelopment,
    type: "github",
    name: "Gemini CLI releases",
    why: "Releases of the coding agent of Google for the terminal.",
    config: { owner: "google-gemini", repo: "gemini-cli" },
    url: "https://github.com/google-gemini/gemini-cli/releases",
  },
  {
    feedSlug: agenticDevelopment,
    type: "github",
    name: "GitHub Copilot CLI releases",
    why: "Releases of the Copilot agent for the terminal.",
    config: { owner: "github", repo: "copilot-cli" },
    url: "https://github.com/github/copilot-cli/releases",
  },
  {
    feedSlug: agenticDevelopment,
    type: "blog",
    name: "GitHub Changelog: Copilot",
    why: "Each change to GitHub Copilot, from the official changelog.",
    config: { feedUrl: "https://github.blog/changelog/label/copilot/feed/" },
    url: "https://github.blog/changelog/label/copilot/",
  },
  {
    feedSlug: agenticDevelopment,
    type: "docs",
    name: "Cursor changelog",
    why: "New capabilities of an editor with a coding agent.",
    config: { url: "https://cursor.com/changelog", mode: "auto" },
    url: "https://cursor.com/changelog",
  },
  {
    feedSlug: agenticDevelopment,
    type: "community",
    name: 'Hacker News: "coding agent"',
    why: "Discussions about coding agents that many engineers voted for.",
    config: { variant: "hn", query: "coding agent", minPoints: 100 },
    url: "https://hn.algolia.com/?q=coding+agent",
  },
  {
    feedSlug: internalAiPlatform,
    type: "blog",
    name: "Microsoft Foundry blog",
    why: "Announcements and guides for the platform below the internal AI app.",
    config: { feedUrl: "https://devblogs.microsoft.com/foundry/feed/" },
    url: "https://devblogs.microsoft.com/foundry/",
  },
  {
    feedSlug: internalAiPlatform,
    type: "github",
    name: "Model Context Protocol releases",
    why: "Changes to the protocol that connects agents to tools and data.",
    config: { owner: "modelcontextprotocol", repo: "modelcontextprotocol" },
    url: "https://github.com/modelcontextprotocol/modelcontextprotocol/releases",
  },
  {
    feedSlug: industryRadar,
    type: "blog",
    name: "OpenAI news",
    why: "Company announcements and model releases of OpenAI.",
    config: { feedUrl: "https://openai.com/news/rss.xml" },
    url: "https://openai.com/news/",
  },
  {
    feedSlug: industryRadar,
    type: "docs",
    name: "Anthropic news",
    why: "Company announcements and model releases of Anthropic.",
    config: { url: "https://www.anthropic.com/news", mode: "auto" },
    url: "https://www.anthropic.com/news",
  },
];
