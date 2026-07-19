import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('./screens/controller/ShadowGate.tsx', import.meta.url).pathname, 'utf8');

describe('ShadowGate enrollment failure visibility', () => {
  it('handles the confirmation result and renders runtime errorReason on the unenrolled gate', () => {
    expect(SRC).toContain('const res = await controller.confirmEnrollment()');
    expect(SRC).toContain("if (!res.ok) setError(state.enrollment.errorReason ?? 'Something went wrong. Please try again.')");
    expect(SRC).not.toContain('onPress={() => void controller.confirmEnrollment()}');
    expect(SRC).toContain('error ?? state.enrollment.errorReason');
  });
});
