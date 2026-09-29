const { buildLiveConnectorSpecsDetailed } = await import('../services/connectorToolBuilder.js');

const ids = ['shared_powerappsforadmins', 'shared_powerappsforappmakers', 'shared_powerplatformforadmins', 'shared_office365users', 'shared_microsoftbookings'];
const { specs } = buildLiveConnectorSpecsDetailed(ids, { ownerScope: 'diag' });
for (const s of specs) {
  console.log(s.id, '-> baseUrlTemplate:', s.baseUrlTemplate, '| scope:', s.scope, '| authKind:', s.authKind, '| tokenUrlTemplate:', s.tokenUrlTemplate);
}
