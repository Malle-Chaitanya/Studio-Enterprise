import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const AGENTS = [
  { sourceId: 'f0365b58-4da9-45e8-a934-e4fa7cde7733', reasoningEngine: 'projects/231705905417/locations/us-central1/reasoningEngines/1606291380424933376' },
  { sourceId: '124794af-3b8f-f111-b8da-0022480b1f83', reasoningEngine: 'projects/231705905417/locations/us-central1/reasoningEngines/7506217998512816128' },
  { sourceId: '48248234-cb90-f111-8077-0022480a981d', reasoningEngine: 'projects/231705905417/locations/us-central1/reasoningEngines/7501855136373800960' },
];

async function ask(saToken: string, reasoningEngine: string, message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${reasoningEngine}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'no-websearch-audit', message } }),
  });
  const text = await res.text();
  const usedWebSearch = text.includes('"web":') || text.includes('search_entry_point');
  const answerMatch = text.match(/"text":\s*"([^"]{0,300})/);
  return { status: res.status, usedWebSearch, answerPreview: answerMatch?.[1] ?? '(no plain text found)' };
}

async function main() {
  const saToken = await getSaToken();
  for (const a of AGENTS) {
    console.log(`\n=== sourceId ${a.sourceId} ===`);
    const r1 = await ask(saToken, a.reasoningEngine, 'What is the current stock price of Microsoft?');
    console.log('Q1 (stock price, should refuse if no web search):', JSON.stringify(r1, null, 2));
  }
}
main().catch((e) => console.error('FAILED:', e.message));
