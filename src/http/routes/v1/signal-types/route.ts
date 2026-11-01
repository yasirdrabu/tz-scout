import { SIGNAL_TYPES } from '@/modules/accounts';
import { v1Route } from '../_lib/v1-route';

// GET /api/v1/signal-types: the signal guide. Each type with its label, kind, what it is and how to read it.
export const GET = v1Route({ permission: 'offers:read' }, async () => ({
  data: Object.entries(SIGNAL_TYPES).map(([type, info]) => ({ type, ...info })),
}));
