import { and, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { sha256 } from '@/platform/idempotency';
import { newId } from '@/platform/ids';
import { batch, batchFile, fileBlob } from '../db/schema';
import { getBatch } from './status';

// Batch files (SRC-E2-S2-AC2). Contents live in `intake.file_blob` (Ruling 4), so the nightly backup covers them.

export const MAX_BATCH_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_BATCH_FILES = 10;

export type FileInput = { fileName: string; contentType: string; bytes: Uint8Array };
export type StoredFile = { storageKey: string; fileName: string; contentType: string; sizeBytes: number; sha256: string };

const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title });

/** Stores the file on a batch the caller already may use. Locks the batch so two uploads can't both take the last place. */
export async function storeFile(ctx: ModuleContext, batchId: string, file: FileInput): Promise<StoredFile> {
  if (file.bytes.byteLength > MAX_BATCH_FILE_BYTES) throw invalid('Files can be up to 25 MB each.');
  await ctx.tx
    .select({ id: batch.id })
    .from(batch)
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)))
    .for('update');
  const [{ n } = { n: 0 }] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(batchFile)
    .where(and(eq(batchFile.tenantId, ctx.tenantId), eq(batchFile.batchId, batchId)));
  if (n >= MAX_BATCH_FILES) throw invalid('A batch can have up to 10 files.');

  const storageKey = newId('blob');
  const stored: StoredFile = {
    storageKey,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.bytes.byteLength,
    sha256: sha256(file.bytes),
  };
  await ctx.tx.insert(fileBlob).values({
    storageKey,
    tenantId: ctx.tenantId,
    content: Buffer.from(file.bytes),
    sizeBytes: stored.sizeBytes,
  });
  await ctx.tx.insert(batchFile).values({
    tenantId: ctx.tenantId,
    batchId,
    fileName: stored.fileName,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    storageKey,
    sha256: stored.sha256,
  });
  return stored;
}

/** Attaches a file to a batch the caller can see; any other batch is a 404. */
export async function attachFile(ctx: ModuleContext, batchId: string, file: FileInput): Promise<StoredFile> {
  if (!(await getBatch(ctx, batchId))) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That batch was not found.' });
  return storeFile(ctx, batchId, file);
}

/** A file on a batch the caller can see, with its contents. Null when the batch or file is not there. */
export async function readFile(
  ctx: ModuleContext,
  batchId: string,
  storageKey: string,
): Promise<(StoredFile & { bytes: Buffer }) | null> {
  if (!(await getBatch(ctx, batchId))) return null;
  const [row] = await ctx.tx
    .select({
      storageKey: batchFile.storageKey,
      fileName: batchFile.fileName,
      contentType: batchFile.contentType,
      sizeBytes: batchFile.sizeBytes,
      sha256: batchFile.sha256,
      bytes: fileBlob.content,
    })
    .from(batchFile)
    .innerJoin(fileBlob, eq(fileBlob.storageKey, batchFile.storageKey))
    .where(and(eq(batchFile.tenantId, ctx.tenantId), eq(batchFile.batchId, batchId), eq(batchFile.storageKey, storageKey)));
  return row ?? null;
}

export type BatchFileView = { fileName: string; contentType: string; sizeBytes: number; sha256: string; createdAt: Date };

/** The files attached to a batch the caller can see, oldest first. Null when the batch is hidden. */
export async function listBatchFiles(ctx: ModuleContext, batchId: string): Promise<BatchFileView[] | null> {
  if (!(await getBatch(ctx, batchId))) return null;
  return ctx.tx
    .select({
      fileName: batchFile.fileName,
      contentType: batchFile.contentType,
      sizeBytes: batchFile.sizeBytes,
      sha256: batchFile.sha256,
      createdAt: batchFile.createdAt,
    })
    .from(batchFile)
    .where(and(eq(batchFile.tenantId, ctx.tenantId), eq(batchFile.batchId, batchId)))
    .orderBy(batchFile.createdAt, batchFile.storageKey);
}
