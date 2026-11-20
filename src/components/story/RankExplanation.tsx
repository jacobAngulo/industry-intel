import { Fragment } from "react";

import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui";
import type { StoryCard } from "@/lib/services/types";

import { decayLine, formatScore, formatSigned } from "./format";

type RankFacts = Pick<StoryCard, "rankParts" | "baseScore" | "score" | "decay">;

function partValue(key: string, value: number): string {
  return key === "relevance" ? formatScore(value) : formatSigned(value);
}

/**
 * "Why this ranks here" (§8.3): the rank parts, the base score, the decay
 * line, and the final score. "list" for the card disclosure, "table" for the story page.
 */
export function RankExplanation({ facts, variant = "list" }: { facts: RankFacts; variant?: "list" | "table" }) {
  const parts = Array.isArray(facts.rankParts) ? facts.rankParts : [];
  if (variant === "table") {
    return (
      <div className="flex flex-col gap-2">
        <Table caption="The parts of the rank score" captionHidden dense>
          <THead>
            <Tr>
              <Th>Part</Th>
              <Th className="text-right">Points</Th>
            </Tr>
          </THead>
          <TBody>
            {parts.map((part, i) => (
              <Tr key={`${part.key}-${i}`}>
                <Td>
                  {part.label}
                  {part.detail ? <span className="mt-0.5 block text-xs text-muted">{part.detail}</span> : null}
                </Td>
                <Td className="text-right tabular-nums">{partValue(part.key, part.value)}</Td>
              </Tr>
            ))}
            <Tr>
              <Th scope="row" className="font-medium">
                Base score
              </Th>
              <Td className="text-right font-medium tabular-nums">{formatScore(facts.baseScore)}</Td>
            </Tr>
            <Tr>
              <Td colSpan={2} className="text-muted">
                {decayLine(facts.decay)}
              </Td>
            </Tr>
            <Tr>
              <Th scope="row" className="font-semibold">
                Score
              </Th>
              <Td className="text-right font-semibold tabular-nums">{formatScore(facts.score)}</Td>
            </Tr>
          </TBody>
        </Table>
        <p className="text-xs text-muted">The decay uses the window &ldquo;7 days&rdquo; of the feed page.</p>
      </div>
    );
  }
  return (
    <div className="max-w-md text-sm">
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        {parts.map((part, i) => (
          <Fragment key={`${part.key}-${i}`}>
            <dt className="text-fg">
              {part.label}
              {part.detail ? <span className="block text-xs text-muted">{part.detail}</span> : null}
            </dt>
            <dd className="text-right tabular-nums">{partValue(part.key, part.value)}</dd>
          </Fragment>
        ))}
        <dt className="mt-1 border-t border-border pt-1 font-medium">Base score</dt>
        <dd className="mt-1 border-t border-border pt-1 text-right font-medium tabular-nums">{formatScore(facts.baseScore)}</dd>
      </dl>
      <p className="mt-1 text-muted">{decayLine(facts.decay)}</p>
      <p className="mt-1 font-medium">
        Score <span className="tabular-nums">{formatScore(facts.score)}</span>
      </p>
    </div>
  );
}
