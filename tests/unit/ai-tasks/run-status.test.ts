import { describe, expect, it } from 'vitest';
import { rawStatuses, runStatus } from '@/modules/ai-tasks/domain/run-status';

describe('run status (Decision 24)', () => {
  it('maps stored statuses to Succeeded, Failed and Stopped by limit, and back', () => {
    expect(runStatus('ok')).toBe('succeeded');
    expect(runStatus('invalid_output')).toBe('failed');
    expect(runStatus('error')).toBe('failed');
    expect(runStatus('refused_by_cap')).toBe('stopped_by_limit');
    expect(rawStatuses('failed')).toEqual(['invalid_output', 'error']);
    expect(rawStatuses('succeeded')).toEqual(['ok']);
    expect(rawStatuses('stopped_by_limit')).toEqual(['refused_by_cap']);
  });
});
