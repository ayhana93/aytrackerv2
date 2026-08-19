/** ISO 3166-1 alpha-2, uppercase. */
export type CountryCode = string;
/** ISO 4217, uppercase. */
export type CurrencyCode = string;
/** BCP 47 language tag. */
export type LocaleCode = string;
/** IANA timezone identifier, e.g. "Europe/Sofia". */
export type TimezoneId = string;

export type MeasurementSystem = 'METRIC' | 'IMPERIAL';

export interface Money {
  /** Amount in major units, as a decimal string to avoid float drift over the wire. */
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type SortDirection = 'asc' | 'desc';

/** Deep-readonly helper for value objects crossing layer boundaries. */
export type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
