/* Pure detection for "this turn is asking to generate/edit an image".

   We deliberately avoid a bare keyword match: words like "render", "icon", and
   "logo" appear constantly in ordinary coding asks ("fix the React render bug",
   "make the icon render correctly", "the logo component is broken"), and a hard
   image directive on those would be wrong. Instead we require explicit
   generate/edit phrasing around a visual-asset noun, an unambiguous visual noun,
   or a "<noun> of …" depiction. */

const IMAGE_GEN_VERB =
  'generate|create|make|produce|draw|render|design|paint|illustrate|sketch|compose|edit|redraw|re-?generate|whip up|cook up';
const IMAGE_NOUN =
  'image|picture|photo|photograph|logo|icon|illustration|drawing|artwork|wallpaper|avatar|sprite|mockup|poster|thumbnail|banner|graphic|portrait|album cover|hero image|emoji|sticker|gif';
// If the noun is immediately used in a code/UI sense, it is NOT an image-gen request.
const NOT_IMAGE_TAIL =
  'component|render(?:s|ing|ed)?|display|show|appear|load|update|click|align|alignment|size|sizing|colou?r|position|cent[er]{2}|state|prop|props|button|css|svg|font|style|class|import|tag|file|header|footer|page|screen|nav|sidebar|modal|tooltip|menu|card|list|row|grid';

const STRONG_IMAGE_NOUN_RE =
  /\b(illustration|artwork|wallpaper|sprite\s*sheet|concept art|photorealistic|oil painting|watercolou?r)\b/i;
const IMAGE_ACTION_RE = new RegExp(
  `\\b(?:${IMAGE_GEN_VERB})\\b[^.?!\\n]{0,24}?\\b(?:${IMAGE_NOUN})\\b(?!\\s+(?:${NOT_IMAGE_TAIL})\\b)`,
  'i',
);
// "<noun> of/showing/depicting <subject>" — a depiction request. Apply the same
// code/UI tail filter as IMAGE_ACTION so "icon of the button", "logo of the header",
// or "image of the page" (UI/code references) do NOT count as image generation. The
// subject (after an optional article) must be a real, non-UI word. Two explicit
// branches (article present / absent) so the tail check can't be bypassed by the
// regex treating the article itself as the subject.
const ARTICLE = 'the|a|an|this|that|these|those|its|their|my|our|your|some';
const IMAGE_OF_RE = new RegExp(
  `\\b(?:${IMAGE_NOUN})\\s+(?:of|showing|depicting)\\s+(?:(?:${ARTICLE})\\s+(?!(?:${NOT_IMAGE_TAIL})\\b)\\w|(?!(?:${ARTICLE})\\b)(?!(?:${NOT_IMAGE_TAIL})\\b)\\w)`,
  'i',
);

/** True when the message reads like a request to create or edit a raster image. */
export function looksLikeImageRequest(text: string): boolean {
  return STRONG_IMAGE_NOUN_RE.test(text) || IMAGE_ACTION_RE.test(text) || IMAGE_OF_RE.test(text);
}
