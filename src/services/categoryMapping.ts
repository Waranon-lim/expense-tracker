export interface CategoryMappingResult {
  category: string;
  source: 'mapping' | 'default';
}

const GENERAL_CATEGORY_MAP: Record<string, string> = {
  FOOD_AND_BEVERAGE: 'Food',
  GROCERY: 'Food',
  TRANSPORTATION: 'Transport',
  ENTERTAINMENT: 'Other',
  UTILITIES: 'Other',
  SHOPPING: 'Other',
  HEALTHCARE: 'Other',
};

const MERCHANT_KEYWORD_MAP: Record<string, string> = {
  STARBUCKS: 'Food',
  MCDONALDS: 'Food',
  UBER: 'Transport',
  GRAB: 'Transport',
  WALGREENS: 'Other',
  AMAZON: 'Other',
};

const UNCATEGORIZED = 'Other';

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
