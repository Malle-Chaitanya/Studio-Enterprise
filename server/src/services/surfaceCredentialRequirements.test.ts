import { describe, it, expect } from 'vitest';
import { expandWithDecidedSurfaceTargets } from './surfaceCredentialRequirements.js';

const registered = (id: string) => id.startsWith('shared_');

describe('expandWithDecidedSurfaceTargets', () => {
  it('asks for the Gmail credential once Outlook is pointed at Gmail', () => {
    // The live gap: the step only knew about shared_office365, so the Google credential was
    // never offered and the deployed agent could not authenticate any mail call.
    expect(
      expandWithDecidedSurfaceTargets(
        ['shared_office365', 'shared_commondataserviceforapps'],
        [{ sourceConnectorId: 'shared_office365', targetConnectorId: 'shared_gmail' }],
        registered,
      ),
    ).toEqual(['shared_office365', 'shared_commondataserviceforapps', 'shared_gmail']);
  });

  it('adds nothing when the decision keeps the same connector', () => {
    expect(
      expandWithDecidedSurfaceTargets(
        ['shared_office365'],
        [{ sourceConnectorId: 'shared_office365', targetConnectorId: 'shared_office365' }],
        registered,
      ),
    ).toEqual(['shared_office365']);
  });

  it('ignores a decision whose source is not in scope for this screen', () => {
    expect(
      expandWithDecidedSurfaceTargets(
        ['shared_commondataserviceforapps'],
        [{ sourceConnectorId: 'shared_office365', targetConnectorId: 'shared_gmail' }],
        registered,
      ),
    ).toEqual(['shared_commondataserviceforapps']);
  });

  it('skips a target that is not a real connector', () => {
    // 'cloudsql' is a decision, not a registry connector — it has no credential card.
    expect(
      expandWithDecidedSurfaceTargets(
        ['shared_commondataserviceforapps'],
        [{ sourceConnectorId: 'shared_commondataserviceforapps', targetConnectorId: 'cloudsql' }],
        registered,
      ),
    ).toEqual(['shared_commondataserviceforapps']);
  });

  it('does not duplicate a target already asked for, and preserves order', () => {
    expect(
      expandWithDecidedSurfaceTargets(
        ['shared_office365', 'shared_gmail'],
        [{ sourceConnectorId: 'shared_office365', targetConnectorId: 'shared_gmail' }],
        registered,
      ),
    ).toEqual(['shared_office365', 'shared_gmail']);
  });

  it('handles several decisions at once', () => {
    expect(
      expandWithDecidedSurfaceTargets(
        ['shared_office365', 'shared_teams'],
        [
          { sourceConnectorId: 'shared_office365', targetConnectorId: 'shared_gmail' },
          { sourceConnectorId: 'shared_teams', targetConnectorId: 'shared_googlechat' },
        ],
        registered,
      ),
    ).toEqual(['shared_office365', 'shared_teams', 'shared_gmail', 'shared_googlechat']);
  });

  it('tolerates a decision with no target recorded', () => {
    expect(
      expandWithDecidedSurfaceTargets(['shared_office365'], [{ sourceConnectorId: 'shared_office365' }], registered),
    ).toEqual(['shared_office365']);
  });
});
