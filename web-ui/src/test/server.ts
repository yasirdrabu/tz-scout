import { setupServer } from 'msw/node';

/** The MSW server every test shares. Tests add handlers with `server.use(...)`. */
export const server = setupServer();
