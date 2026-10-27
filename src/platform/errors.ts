export const PROBLEM_BASE = 'https://scout.taazaa.ai/problems/';

export type ProblemJson = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
} & Record<string, unknown>;

export type ScoutErrorInit = {
  slug: string;
  status: number;
  title: string;
  detail?: string;
  errors?: { path: string; message: string }[];
  /** Response headers to send with the problem, e.g. `retry-after`. */
  headers?: Record<string, string>;
  /** Extra members merged into the problem body, e.g. `resets_at`. */
  extensions?: Record<string, unknown>;
};

export class ScoutError extends Error {
  readonly slug: string;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: { path: string; message: string }[];
  readonly headers?: Record<string, string>;
  readonly extensions?: Record<string, unknown>;

  constructor(init: ScoutErrorInit) {
    super(init.title);
    this.name = 'ScoutError';
    this.slug = init.slug;
    this.status = init.status;
    this.detail = init.detail;
    this.errors = init.errors;
    this.headers = init.headers;
    this.extensions = init.extensions;
  }
}

export function toProblem(e: unknown): { status: number; body: ProblemJson; headers?: Record<string, string> } {
  if (e instanceof ScoutError) {
    const body: ProblemJson = {
      ...e.extensions,
      type: PROBLEM_BASE + e.slug,
      title: e.message,
      status: e.status,
    };
    if (e.detail !== undefined) body.detail = e.detail;
    if (e.errors !== undefined) body.errors = e.errors;
    return { status: e.status, body, ...(e.headers ? { headers: e.headers } : {}) };
  }
  return {
    status: 500,
    body: { type: PROBLEM_BASE + 'internal', title: 'Something went wrong', status: 500 },
  };
}
