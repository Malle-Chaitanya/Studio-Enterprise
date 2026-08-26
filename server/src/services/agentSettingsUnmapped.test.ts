import { describe, it, expect } from 'vitest';
import { extractAgentSettingsForReport } from './dataverse.js';

/**
 * Bot-configuration switches we read but do not reproduce.
 *
 * Sales desk carries nine of them and every one was dropped with `unmapped: []`, so the
 * fidelity report implied nothing had been left behind. The rule is honesty, not coverage:
 * we are allowed not to map these, we are not allowed to be silent about them.
 *
 * The payload below is Sales desk's real `configuration` blob, trimmed.
 */
const SALES_DESK = JSON.stringify({
  $kind: 'BotConfiguration',
  channels: [{ $kind: 'ChannelDefinition', channelId: 'MsTeams' },
             { $kind: 'ChannelDefinition', channelId: 'Microsoft365Copilot' }],
  settings: { GenerativeActionsEnabled: true },
  isAgentConnectable: true,
  publishOnImport: true,
  isLightweightBot: false,
  aISettings: {
    $kind: 'AISettings', useModelKnowledge: true, isFileAnalysisEnabled: true,
    isSemanticSearchEnabled: true, contentModeration: 'Low', optInUseLatestModels: false,
  },
  recognizer: { $kind: 'GenerativeAIRecognizer' },
});

const lines = (cfg?: string) => extractAgentSettingsForReport(cfg).otherSettings ?? [];

describe('bot-configuration settings reach the report', () => {
  it('names the surfaces the agent was published to', () => {
    // The one that stings most: this records where people actually USE the agent, and
    // surface-equivalence was answering "none" because nothing read it.
    expect(lines(SALES_DESK).join('\n')).toMatch(/channels=MsTeams,Microsoft365Copilot/);
  });

  it('names agent-to-agent connectability', () => {
    expect(lines(SALES_DESK).some((l) => l.startsWith('isAgentConnectable=true'))).toBe(true);
  });

  it('carries aISettings whole rather than a hand-listed few', () => {
    const out = lines(SALES_DESK).join('\n');
    // Enumerating them would mean a toggle Microsoft adds next month vanishes silently.
    for (const k of ['useModelKnowledge', 'isFileAnalysisEnabled', 'isSemanticSearchEnabled',
                     'contentModeration', 'optInUseLatestModels']) {
      expect(out).toContain(`aISettings.${k}=`);
    }
    // $kind is a type tag, not a customer setting — noise in a fidelity report.
    expect(out).not.toContain('aISettings.$kind');
  });

  it('reports false-valued toggles too, instead of only the true ones', () => {
    // `optInUseLatestModels=false` is a decision the author made. Dropping falses would
    // report a partial picture as a complete one.
    expect(lines(SALES_DESK).join('\n')).toContain('aISettings.optInUseLatestModels=false');
  });

  it('says nothing for an agent with none of these set', () => {
    expect(lines(JSON.stringify({ $kind: 'BotConfiguration' }))).toEqual([]);
  });

  it('survives an unparseable configuration instead of failing extraction', () => {
    expect(lines('{not json')).toEqual([]);
    expect(lines(undefined)).toEqual([]);
  });
});
