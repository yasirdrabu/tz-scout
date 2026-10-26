import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { config } from '@/platform/config';

export type Nats = { nc: NatsConnection; js: JetStreamClient; jsm: JetStreamManager };

/**
 * Connects to NATS and keeps reconnecting forever. Waits for the first connection, so
 * it also works when NATS starts after this process.
 */
export async function connectNats(url: string = config.natsUrl): Promise<Nats> {
  const nc = await connect({
    servers: url,
    name: 'scout',
    waitOnFirstConnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
  });
  const js = jetstream(nc, { timeout: 3000 });
  const jsm = await jetstreamManager(nc, { timeout: 3000 });
  return { nc, js, jsm };
}
