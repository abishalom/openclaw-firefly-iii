export interface FireflyResource<T> {
  type: string;
  id: string;
  attributes: T;
  links?: unknown;
}

export interface FireflyPagination {
  total?: number;
  count?: number;
  per_page?: number;
  current_page?: number;
  total_pages?: number;
}

export interface FireflyCollection<T> {
  data: Array<FireflyResource<T>>;
  meta: { pagination?: FireflyPagination };
  links?: unknown;
}

export interface FireflySingle<T> {
  data: FireflyResource<T>;
}

export interface Pagination {
  total: number | null;
  count: number;
  perPage: number | null;
  currentPage: number;
  totalPages: number | null;
}

export function normalizePagination(
  pagination: FireflyPagination | undefined,
  itemCount: number,
): Pagination {
  return {
    total: typeof pagination?.total === "number" ? pagination.total : null,
    count: typeof pagination?.count === "number" ? pagination.count : itemCount,
    perPage: typeof pagination?.per_page === "number" ? pagination.per_page : null,
    currentPage: typeof pagination?.current_page === "number" ? pagination.current_page : 1,
    totalPages: typeof pagination?.total_pages === "number" ? pagination.total_pages : null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
