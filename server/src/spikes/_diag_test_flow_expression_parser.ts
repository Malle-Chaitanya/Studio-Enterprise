/** Verify flowExpression.ts against the EXACT real strings pulled from live Deal Desk
 *  flows this session, before trusting it inside the mapper.
 *  npx tsx src/spikes/_diag_test_flow_expression_parser.ts */
import { parseTemplate, unwrapAccessors } from '../services/flowExpression.js';

function show(label: string, value: string) {
  console.log(`\n=== ${label} ===`);
  console.log('input:', JSON.stringify(value));
  const parts = parseTemplate(value);
  for (const p of parts) {
    if (p.kind === 'literal') console.log('  LITERAL:', JSON.stringify(p.text));
    else {
      console.log('  EXPR:', JSON.stringify(p.expr));
      const u = unwrapAccessors(p.expr);
      if (u) console.log('  unwrapped:', u.root.name, '(', u.root.args.map((a) => JSON.stringify(a)).join(', '), ') keys=', u.keys);
    }
  }
}

show('DraftFollowUpEmail Compose', "New limit approved. Rate updated. Covenant status unchanged. Details:\n\n@{triggerBody()?['text']}  \n@{triggerBody()?['text_1']} \n@{triggerBody()?['text_2']}  \n@{triggerBody()?['text_3']}\n\n");
show('DraftFollowUpEmail Response body', "@{outputs('Compose')}");
show('Postoteams Response body', "@{outputs('Post_message_in_a_chat_or_channel')?['body/messageLink']}");
show('GetRateSheetBand Response body', "@{body('Filter_array')}");
show('GetRateSheetBand Query.from', "@outputs('List_rows_present_in_a_table')?['body/value']");
show('GetRateSheetBand Query.where', "@and(lessOrEquals(int(item()['Limit Band Min']), triggerBody()['number']), greater(int(item()['Limit Band Max']), triggerBody()['number']))\n");
show('Postoteams connector body/recipient (literal)', 'erik@filefuze.co');
show('Postoteams connector messageBody (mixed template)', '<p class="editor-paragraph">Here\'s the amendment summary:</p><br><br><p class="editor-paragraph">@{triggerBody()?[\'text\']}</p>');
process.exit(0);
