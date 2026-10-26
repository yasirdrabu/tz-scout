import type { z } from 'zod';

const EVENT_TYPE = /^[a-z_]+\.[a-z_]+\.[a-z_]+$/;
const JOB_NAME = /^[a-z_]+(\.[a-z_]+)+$/;

export type EventDef<D> = { type: string; schemaVersion: number; data: z.ZodType<D> };
export type JobOptions = { maxDeliver?: number; backoffMs?: number[]; timeoutMs?: number };
export type JobDef<D> = { name: string; data: z.ZodType<D>; opts: JobOptions };

const events = new Map<string, EventDef<unknown>>();
const jobs = new Map<string, JobDef<unknown>>();

export function defineEvent<D>(type: string, schemaVersion: number, data: z.ZodType<D>): EventDef<D> {
  if (!EVENT_TYPE.test(type)) throw new Error(`Invalid event type "${type}": expected <schema>.<entity>.<verb>`);
  const def: EventDef<D> = { type, schemaVersion, data };
  events.set(type, def as EventDef<unknown>);
  return def;
}

export function defineJob<D>(name: string, data: z.ZodType<D>, opts: JobOptions = {}): JobDef<D> {
  if (!JOB_NAME.test(name)) throw new Error(`Invalid job name "${name}": expected dotted lowercase words`);
  const def: JobDef<D> = { name, data, opts };
  jobs.set(name, def as JobDef<unknown>);
  return def;
}

export const eventDef = (type: string): EventDef<unknown> | undefined => events.get(type);
export const jobDef = (name: string): JobDef<unknown> | undefined => jobs.get(name);
