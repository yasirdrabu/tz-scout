export const PROBLEM_BASE = 'https://scout.taazaa.ai/problems/';

export type ProblemJson = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
};

export type ScoutErrorInit = {
  slug: string;
  status: number;
  title: string;
  detail?: string;
  errors?: { path: string; message: string }[];
};

export class ScoutError extends Error {
  readonly slug: string;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: { path: string; message: string }[];

  constructor(init: ScoutErrorInit) {
    super(init.title);
    this.name = 'ScoutError';
    this.slug = init.slug;
    this.status = init.status;
    this.detail = init.detail;
    this.errors = init.errors;
  }
}

export function toProblem(e: unknown): { status: number; body: ProblemJson } {
  if (e instanceof ScoutError) {
    const body: ProblemJson = {
      type: PROBLEM_BASE + e.slug,
      title: e.message,
      status: e.status,
    };
    if (e.detail !== undefined) body.detail = e.detail;
    if (e.errors !== undefined) body.errors = e.errors;
    return { status: e.status, body };
  }
  return {
    status: 500,
    body: { type: PROBLEM_BASE + 'internal', title: 'Something went wrong', status: 500 },
  };
}
