import { RetentionPolicy, StorageType, type JetStreamManager, type StreamConfig } from '@nats-io/jetstream';
import { MODULE_SCHEMAS } from './subjects';

// Relay retries re-send the same msgID; they must stay inside this window to be deduplicated.
const DUPLICATE_WINDOW_NS = 2 * 60 * 1_000_000_000;
const DAY_NS = 24 * 60 * 60 * 1_000_000_000;

type StreamSpec = Partial<StreamConfig> & { name: string; subjects: string[] };

export const STREAMS: StreamSpec[] = [
  {
    name: 'SCOUT_EVENTS',
    subjects: MODULE_SCHEMAS.map((m) => `scout.*.${m}.>`),
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 90 * DAY_NS,
    duplicate_window: DUPLICATE_WINDOW_NS,
  },
  {
    name: 'SCOUT_JOBS',
    subjects: ['scout.*.jobs.>'],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    duplicate_window: DUPLICATE_WINDOW_NS,
  },
  {
    name: 'SCOUT_WEBHOOKS',
    subjects: ['scout.*.webhooks.deliver'],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
  },
  {
    name: 'SCOUT_REPLAY',
    subjects: ['scout.*.replay.>'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 7 * DAY_NS,
  },
];

/** Creates the four streams, or updates them when they already exist. Safe to call repeatedly. */
export async function ensureStreams(jsm: JetStreamManager): Promise<void> {
  for (const spec of STREAMS) {
    let exists = true;
    try {
      await jsm.streams.info(spec.name);
    } catch (e) {
      if (/not found/i.test(String((e as Error).message))) exists = false;
      else throw e;
    }
    if (exists) await jsm.streams.update(spec.name, spec);
    else await jsm.streams.add(spec);
  }
}
