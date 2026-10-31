/** The problem+json body the API sends (src/platform/errors.ts toProblem, snake_case). */
type Problem = {
  type?: unknown;
  title?: unknown;
  status?: unknown;
  detail?: unknown;
  correlation_id?: unknown;
  errors?: unknown;
};

export type FieldError = { path: string; message: string };

export type ApiErrorInit = {
  status: number;
  title: string;
  detail?: string | undefined;
  /** The problem slug, for example `forbidden` or `slug-taken`. */
  code: string;
  /** The correlation id, shown as "Error ref {ref}" so support can find the request. */
  ref: string;
  errors?: FieldError[] | undefined;
};

/** Any failed API call. `message` is the copy to show: the API's detail, else its title. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly code: string;
  readonly ref: string;
  readonly errors: FieldError[];

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.code = init.code;
    this.ref = init.ref;
    this.errors = init.errors ?? [];
  }
}

/** A 401: no session, or it expired. The app sends the person to sign in. */
export class UnauthorizedError extends ApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'UnauthorizedError';
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function fieldErrors(v: unknown): FieldError[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(
    (e): e is FieldError => typeof e === 'object' && e !== null && typeof e.path === 'string' && typeof e.message === 'string',
  );
}

/** Builds the error for a failed response. `body` is the parsed JSON, or null when there was none. */
export function errorFrom(status: number, body: unknown, ref: string): ApiError {
  const p: Problem = typeof body === 'object' && body !== null ? body : {};
  const type = str(p.type);
  const init: ApiErrorInit = {
    status,
    title: str(p.title) ?? 'Something went wrong',
    detail: str(p.detail),
    code: type ? (type.split('/').pop() ?? 'unknown') : 'unknown',
    ref: str(p.correlation_id) ?? ref,
    errors: fieldErrors(p.errors),
  };
  return status === 401 ? new UnauthorizedError(init) : new ApiError(init);
}

export function networkError(ref: string): ApiError {
  return new ApiError({
    status: 0,
    title: "Scout can't be reached",
    detail: 'Check your connection and try again.',
    code: 'network',
    ref,
  });
}
