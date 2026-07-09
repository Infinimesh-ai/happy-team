import { describe, expect, it } from 'vitest';
import { getClaudeAgentSdkBinaryCandidates, hasBundledClaudeAgentSdk, resolveClaudeAvailability } from './detectCLI';

describe('detectCLIAvailability Claude support', () => {
  it('treats the bundled Claude Agent SDK as remote-mode Claude availability', () => {
    expect(resolveClaudeAvailability(false, true)).toBe(true);
  });

  it('keeps the global claude command as sufficient availability', () => {
    expect(resolveClaudeAvailability(true, false)).toBe(true);
  });

  it('reports unavailable when neither global claude nor the bundled SDK can be found', () => {
    expect(resolveClaudeAvailability(false, false)).toBe(false);
  });

  it('can resolve the declared Claude Agent SDK dependency', () => {
    expect(hasBundledClaudeAgentSdk()).toBe(true);
  });

  it('knows the current platform Claude SDK native binary package name', () => {
    expect(getClaudeAgentSdkBinaryCandidates().length).toBeGreaterThan(0);
  });
});
