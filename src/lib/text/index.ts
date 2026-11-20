/**
 * Text tools for the connectors and the pipeline (§11.2 of the specification).
 * No function here makes a network call.
 */
export { htmlToText } from "./blocks";
export { extractArticle, splitSections, type Section } from "./article";
export { canonicalizeUrl, extractLinks, isRootUrl } from "./url";
export { normalizeForHash, sha, significantWords, slugify, stripInvisible, truncate } from "./words";
export { decodeEntities } from "./entities";
