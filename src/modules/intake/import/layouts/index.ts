import type { ArrivalV1 } from '../../contracts/arrival';
import type { ParsedFile } from '../parse';
import { researchLayout, researchMasterLayout } from './research';
import { vibeExportLayout } from './vibe';

/** One company's arrival body, with the file rows it came from (`payload.raw`). */
export type ArrivalDraft = {
  body: ArrivalV1;
  raw: { headers: string[]; rows: string[][] };
};

/** A file layout Scout already knows, so the person does not map columns. */
export type ImportLayout = {
  key: 'research' | 'research_master' | 'vibe_export';
  detect(headers: string[]): boolean;
  toArrivals(parsed: ParsedFile, ctx: { now: Date; fileName: string }): ArrivalDraft[];
};

/** First match wins, so a stacked master file is listed before the plain research layout. A new layout is a new entry. */
export const LAYOUTS: ImportLayout[] = [researchMasterLayout, researchLayout, vibeExportLayout];

export function detectLayout(headers: string[]): ImportLayout | null {
  return LAYOUTS.find((l) => l.detect(headers)) ?? null;
}
