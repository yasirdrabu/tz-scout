import { authHandler } from '@/modules/tenancy';

// Mounts better-auth (Microsoft sign-in, callback, session, sign-out) under /api/auth.
export const GET = (request: Request) => authHandler(request);
export const POST = (request: Request) => authHandler(request);
