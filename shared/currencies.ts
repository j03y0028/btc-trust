/** Fiat currencies BTC Trust can show amounts in (backend price feed + frontend picker share this list). */
export const CURRENCIES = [
  ['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['CAD', 'Canadian Dollar'], ['AUD', 'Australian Dollar'],
  ['JPY', 'Japanese Yen'], ['CHF', 'Swiss Franc'], ['MXN', 'Mexican Peso'], ['BRL', 'Brazilian Real'], ['INR', 'Indian Rupee'],
  ['CNY', 'Chinese Yuan'], ['KRW', 'South Korean Won'], ['SGD', 'Singapore Dollar'], ['HKD', 'Hong Kong Dollar'],
  ['NZD', 'New Zealand Dollar'], ['SEK', 'Swedish Krona'], ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'],
  ['PLN', 'Polish Złoty'], ['ZAR', 'South African Rand'], ['TRY', 'Turkish Lira'], ['AED', 'UAE Dirham'],
] as const;
export type CurrencyCode = (typeof CURRENCIES)[number][0];
