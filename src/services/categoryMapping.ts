export interface CategoryMappingResult {
  category: string;
  source: 'mapping' | 'default';
}

const GENERAL_CATEGORY_MAP: Record<string, string> = {
  FOOD_AND_BEVERAGE: 'Dining Out',
  GROCERY: 'Groceries',
  TRANSPORTATION: 'Transport',
  ENTERTAINMENT: 'Entertainment',
  UTILITIES: 'Bills & Utilities',
  SHOPPING: 'Shopping',
  HEALTHCARE: 'Health',
};

const MERCHANT_KEYWORD_MAP: Record<string, string> = {
  STARBUCKS: 'Dining Out',
  MCDONALDS: 'Dining Out',
  UBER: 'Transport',
  WALGREENS: 'Health',
  AMAZON: 'Shopping',
};

const UNCATEGORIZED = 'Uncategorized';

export function mapBankCategory(bankCategory: string, _merchantName: string): CategoryMappingResult {
  const normalized = bankCategory.toUpperCase();

  const direct = GENERAL_CATEGORY_MAP[normalized];
  if (direct) {
    return { category: direct, source: 'mapping' };
  }

  const tokens = normalized.split('_');
  for (const token of tokens) {
    const merchantMatch = MERCHANT_KEYWORD_MAP[token];
    if (merchantMatch) {
      return { category: merchantMatch, source: 'mapping' };
    }
  }

  return { category: UNCATEGORIZED, source: 'default' };
}
