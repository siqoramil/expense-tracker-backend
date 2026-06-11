import type { Types } from 'mongoose';
import { Category } from '../models/Category.js';

interface DefaultCategory {
  label: { en: string; uz: string };
  icon: string;
  color: string;
  kind: 'income' | 'expense';
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { label: { en: 'Food',      uz: 'Ovqat'     }, icon: 'coffee',    color: '#F59E0B', kind: 'expense' },
  { label: { en: 'Transport', uz: 'Transport'  }, icon: 'car',       color: '#3B82F6', kind: 'expense' },
  { label: { en: 'Shopping',  uz: 'Xarid'     }, icon: 'cart',      color: '#EC4899', kind: 'expense' },
  { label: { en: 'Rent',      uz: 'Ijara'     }, icon: 'home-icon', color: '#8B5CF6', kind: 'expense' },
  { label: { en: 'Bills',     uz: 'Kommunal'  }, icon: 'phone',     color: '#06B6D4', kind: 'expense' },
  { label: { en: 'Salary',    uz: 'Maosh'     }, icon: 'briefcase', color: '#10B981', kind: 'income'  },
  { label: { en: 'Bonus',     uz: 'Bonus'     }, icon: 'gift',      color: '#14B8A6', kind: 'income'  },
];

// Inserts any default categories that are missing for the given user.
// Matching is done by kind + label.en — the same key the mobile bootstrap
// uses for dedup, so existing docs are linked rather than duplicated.
// Safe to call repeatedly; already-present entries are skipped.
export async function seedDefaultCategories(userId: Types.ObjectId | string): Promise<void> {
  const existing = await Category.find(
    { userId },
    { 'label.en': 1, kind: 1, _id: 0 },
  ).lean();

  const existingKeys = new Set(
    existing
      .filter((c) => c.label != null)
      .map((c) => `${c.kind}|${c.label!.en}`),
  );

  const toInsert = DEFAULT_CATEGORIES.filter(
    (d) => !existingKeys.has(`${d.kind}|${d.label.en}`),
  ).map((d) => ({ ...d, userId }));

  if (toInsert.length > 0) {
    await Category.insertMany(toInsert, { ordered: false });
  }
}
