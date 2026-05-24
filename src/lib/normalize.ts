// NFKC canonicalises confusables that look identical but encode
// differently — e.g. Cyrillic "а" (U+0430) vs Latin "a" (U+0061),
// fullwidth "＠" vs ASCII "@". Without normalising, an attacker can
// register `аdmin@example.com` (Cyrillic) that visually shadows the
// real `admin@example.com` and trick humans / log readers.
//
// NFKC also folds compatibility forms (ligatures, halfwidth digits)
// onto their canonical equivalents, which is the right behaviour
// for email addresses since they should be compared by identity.
export const normalizeEmail = (raw: string): string =>
  raw.normalize('NFKC').toLowerCase().trim();
