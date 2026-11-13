/**
 * Phase 8: deterministic Article language identification (no AI call).
 *
 * Order of trust: language metadata declared by the feed, then a lightweight
 * script/wording heuristic over the Article's own text, then "unknown".
 * Only languages the heuristic can tell apart reliably are ever returned.
 */

export const UNKNOWN_LANGUAGE = "unknown";

/** "vi-VN" → "vi", "en-gb" → "en", "ja" → "ja"; anything else → null. */
export function normalizeLanguageTag(tag: string | null | undefined): string | null {
  const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HAN = /\p{Script=Han}/gu;
const HANGUL = /\p{Script=Hangul}/gu;
const LATIN = /\p{Script=Latin}/gu;
/** Any Vietnamese diacritic letter (some, like é/à/ê, are shared with French, Portuguese, …). */
const VIETNAMESE_LETTER = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/iu;
/** Letters used only by Vietnamese (ă đ ơ ư, hook above, dot below, stacked tone marks). */
const VIETNAMESE_ONLY_LETTER = /[ăđơưảạằắẳẵặầấẩẫậẻẽẹềếểễệỉĩịỏọồốổỗộờớởỡợủũụừứửữựỳỷỹỵ]/iu;
const ENGLISH_FUNCTION_WORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "with", "is", "are", "was", "were", "has", "have",
  "after", "by", "from", "as", "at", "who", "that", "this", "his", "her", "their", "its", "be", "will", "over",
]);

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Detects ja / ko / vi / en from text. Han-only text (Chinese or kana-less
 * Japanese) and unrecognised Latin text return "unknown" rather than a guess.
 */
export function detectLanguage(text: string | null | undefined): string {
  const value = (text ?? "").normalize("NFC");
  const kana = countMatches(value, KANA);
  const han = countMatches(value, HAN);
  const hangul = countMatches(value, HANGUL);
  const latin = countMatches(value, LATIN);
  const letters = kana + han + hangul + latin;
  if (letters === 0) return UNKNOWN_LANGUAGE;

  if (kana > 0 && (kana + han) / letters >= 0.3) return "ja";
  if (hangul / letters >= 0.3) return "ko";
  if (latin / letters < 0.7) return UNKNOWN_LANGUAGE;

  const words = value
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => /\p{Script=Latin}/u.test(word));
  if (words.length === 0) return UNKNOWN_LANGUAGE;

  const vietnameseWords = words.filter((word) => VIETNAMESE_LETTER.test(word)).length;
  if (vietnameseWords / words.length >= 0.2 && VIETNAMESE_ONLY_LETTER.test(value)) return "vi";

  // English, tolerating a few accented proper names ("Vinícius", "El Niño").
  const nonAsciiWords = words.filter((word) => !/^[a-z]+$/.test(word)).length;
  const functionWords = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
  if (nonAsciiWords / words.length <= 0.1 && words.length >= 3 && functionWords >= 1) return "en";

  return UNKNOWN_LANGUAGE;
}

/** Feed metadata first, then local detection over title + excerpt, else "unknown". */
export function resolveArticleLanguage(input: {
  feedLanguage?: string | null;
  title: string;
  excerpt?: string | null;
}): string {
  return normalizeLanguageTag(input.feedLanguage) ?? detectLanguage(`${input.title} ${input.excerpt ?? ""}`);
}
