import { decodeEntities } from "./entities";

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Reads the attributes of one tag (the text between the tag name and ">").
 * Names are lower case. Values have their character references decoded.
 * The first value of a repeated name wins.
 */
export function parseAttributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "" || name === "__proto__" || Object.hasOwn(out, name)) continue;
    out[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}
