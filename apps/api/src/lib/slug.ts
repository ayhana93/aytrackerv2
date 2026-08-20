/**
 * Turning names people type into keys the system can use.
 *
 * Two callers, one problem: an organization slug (`acme-ood`) and a work-area code (`ZONE-A`)
 * are both derived from a Bulgarian name and both have to survive being typed on a Latin
 * keyboard by a worker at a terminal.
 *
 * Stripping Cyrillic instead of transliterating it is the failure mode worth naming: it turns
 * "Метал Инвест" into an empty string, so every Bulgarian company would get `org-2`, `org-3`,
 * `org-4` and every work area would be `AREA-2` — the same as having no derivation at all.
 *
 * The mapping is the official streamlined system (ъ → a, я → ya), the one on Bulgarian
 * passports, so a name transliterated here matches what people already expect to see.
 */

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
};

/** Combining diacritical marks, dropped after NFD so "Café" becomes "cafe" rather than "caf". */
const COMBINING_MARKS = /[̀-ͯ]/g;

export function slugify(value: string, maxLength = 48): string {
  return value
    .toLowerCase()
    .split('')
    .map((character) => CYRILLIC_TO_LATIN[character] ?? character)
    .join('')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * A short uppercase code, as printed on a sign above a work area.
 *
 * Hyphen-free and capped hard: this ends up on a QR label and in a dropdown next to twenty
 * others, so "ZONEAPACKAGING" helps nobody. Callers must still resolve collisions — a code is
 * unique per organization, and no derivation can promise that on its own.
 */
export function deriveCode(value: string, maxLength = 12): string {
  const compact = slugify(value, 64).replace(/-/g, '').toUpperCase();
  return compact.slice(0, maxLength);
}
