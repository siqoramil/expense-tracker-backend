export const normalizeEmail = (raw: string): string => raw.normalize('NFKC').toLowerCase().trim();
