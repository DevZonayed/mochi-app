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

  it('awaits capability selection before account or QR enrollment begins, and fails closed if that apply step is rejected', () => {
    expect(SRC).toContain('const applied = await controller.setRequestedCapabilities(requestedCapabilitiesFor(mode, [...selected], screenView));');
    expect(SRC).toContain("if (!applied) {");
    expect(SRC).toContain("setError('Could not apply the selected access before enrollment. Try again.')");
    expect(SRC).toContain('if (!await applyRequestedCapabilities()) return;');
    expect(SRC).not.toContain('void controller.setRequestedCapabilities(requestedCapabilitiesFor(mode, [...selected], screenView));');
  });

  it('single-flights enrollment start actions while the capability apply or start call is in flight', () => {
    expect(SRC).toContain("const [startingEnrollment, setStartingEnrollment] = React.useState(false);");
    expect(SRC).toContain('if (startingEnrollment) return;');
    expect(SRC).toContain('setStartingEnrollment(true);');
    expect(SRC).toContain('setStartingEnrollment(false);');
    expect(SRC).toContain('busy={state.busy || startingEnrollment}');
  });

  it('shows truthful confirmation copy for staged capabilities and pre-identity device text', () => {
    expect(SRC).toContain('label="This device" value={state.enrollment.controllerDeviceLabel} mono');
    expect(SRC).toContain('label="Requesting" value={state.enrollment.requestedCapabilityLabels.join(\', \')}');
    expect(SRC).not.toContain("controllerDeviceIdShort ?? '—'");
  });
});
