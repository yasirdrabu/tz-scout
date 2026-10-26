import { auth } from '@/modules/tenancy';

// Mounts better-auth: Microsoft sign-in, callback, session and sign-out under /api/auth.
export const GET = (request: Request) => auth.handler(request);
export const POST = (request: Request) => auth.handler(request);
