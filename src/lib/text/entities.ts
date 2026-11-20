/**
 * Decoder for HTML character references. It knows the HTML 4 names, a set of
 * common HTML 5 names, and the numeric forms. A reference must end with ";".
 */

const NAMED = new Map<string, string>();

function addRun(names: string, firstCode: number): void {
  let code = firstCode;
  for (const name of names.split(" ")) {
    NAMED.set(name, String.fromCodePoint(code));
    code += 1;
  }
}

// U+00A0 to U+00FF, in order.
addRun(
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr " +
    "deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
    "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
    "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
    "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml " +
    "eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml",
  0xa0,
);
// Greek capital letters: U+0391 to U+03A1, then U+03A3 to U+03A9.
addRun("Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho", 0x391);
addRun("Sigma Tau Upsilon Phi Chi Psi Omega", 0x3a3);
// Greek small letters: U+03B1 to U+03C9.
addRun(
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma " +
    "tau upsilon phi chi psi omega",
  0x3b1,
);

const SINGLE: Record<string, number> = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62,
  Tab: 9, NewLine: 10, excl: 33, num: 35, dollar: 36, percnt: 37, lpar: 40, rpar: 41, ast: 42, plus: 43,
  comma: 44, period: 46, sol: 47, colon: 58, semi: 59, equals: 61, quest: 63, commat: 64, lsqb: 91, lbrack: 91,
  bsol: 92, rsqb: 93, rbrack: 93, Hat: 94, lowbar: 95, grave: 96, lcub: 123, lbrace: 123, verbar: 124, vert: 124,
  rcub: 125, rbrace: 125,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  thetasym: 977, upsih: 978, piv: 982,
  ensp: 8194, emsp: 8195, thinsp: 8201, hairsp: 8202, ZeroWidthSpace: 8203, zwnj: 8204, zwj: 8205, lrm: 8206,
  rlm: 8207, hyphen: 8208, dash: 8208, ndash: 8211, mdash: 8212, horbar: 8213, lsquo: 8216, rsquo: 8217,
  sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, bullet: 8226,
  hellip: 8230, mldr: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254,
  frasl: 8260, NoBreak: 8288, euro: 8364, image: 8465, weierp: 8472, real: 8476, trade: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658,
  dArr: 8659, hArr: 8660, leftarrow: 8592, rightarrow: 8594,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715,
  prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736,
  and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776,
  ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839,
  oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971,
  lang: 9001, rang: 9002, loz: 9674, starf: 9733, bigstar: 9733, star: 9734, spades: 9824, clubs: 9827,
  hearts: 9829, diams: 9830, check: 10003, checkmark: 10003, cross: 10007,
};
for (const [name, code] of Object.entries(SINGLE)) NAMED.set(name, String.fromCodePoint(code));

/** Windows-1252 meaning of the numeric references 128 to 159 (as browsers read them). */
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d,
  0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x9d, 0x017e, 0x0178,
];

const REFERENCE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function fromCode(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return String.fromCodePoint(CP1252[code - 0x80] ?? 0xfffd);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

/**
 * Decodes the character references of a text one time ("&amp;lt;" becomes "&lt;").
 * A reference that the decoder does not know stays as it is.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (all: string, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const second = body.charCodeAt(1);
      const code =
        second === 120 || second === 88 ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? fromCode(code) : all;
    }
    return NAMED.get(body) ?? all;
  });
}
