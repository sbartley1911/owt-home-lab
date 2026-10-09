import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateSuite(suite) {
  if (!suite.version || !Array.isArray(suite.cases) || !suite.cases.length) throw Error('Empty or unversioned suite');
  const ids = new Set();
  for (const c of suite.cases) {
    if (!c.id || ids.has(c.id) || !c.query || !Number.isInteger(c.count) || c.count < 1 ||
        !Array.isArray(c.expected_ids) || !c.expected_ids.length ||
        c.expected_ids.some(id => !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) {
      throw Error('Invalid or duplicate evaluation case');
    }
    ids.add(c.id);
  }
}

// Expects an MCP tools/call result, or the row array returned by semantic_search.
export function rowsFromResponse(response) {
  if (response?.isError) throw Error('MCP tool error');
  if (Array.isArray(response)) return response;
  const text = response?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw Error('Expected a search row array');
  return rows;
}

export function score(suite, evidence) {
  validateSuite(suite);
  if (evidence.suite_sha256 !== digest(suite)) throw Error('Evidence belongs to a different suite');
  if (!Array.isArray(evidence.cases) || evidence.cases.length !== suite.cases.length ||
      new Set(evidence.cases.map(c => c.id)).size !== suite.cases.length) throw Error('Incomplete or duplicate evidence');
  const cases = suite.cases.map(c => {
    const run = evidence.cases.find(r => r.id === c.id);
    if (!run || !run.executed_at || !Number.isFinite(Date.parse(run.executed_at))) throw Error('Missing case or timestamp');
    const base = {id:c.id, query:c.query, count:c.count, source:c.source ?? null, executed_at:run.executed_at};
    try {
      if (run.error) throw Error('Transport error');
      const rows = rowsFromResponse(run.response);
      if (!rows.length || rows.some(r => !['results','empty','error'].includes(r.outcome)) ||
          new Set(rows.map(r => r.outcome)).size !== 1 || rows[0].outcome === 'error') throw Error('Retrieval error or invalid envelope');
      if (rows.some(r => !r.request_id) || new Set(rows.map(r=>r.request_id)).size !== 1) throw Error('Missing or conflicting request identity');
      const hits = rows.filter(r => r.id);
      if ((rows[0].outcome === 'empty' && (hits.length || rows.length !== 1)) ||
          (rows[0].outcome === 'results' && hits.length !== rows.length) || hits.length > c.count) throw Error('Malformed hits');
      const rank = hits.findIndex(r => c.expected_ids.includes(r.id));
      return {...base, status:rank < 0 ? 'miss' : 'hit', rank:rank < 0 ? null : rank+1,
        request_id:rows[0].request_id, telemetry:rows.every(r=>r.telemetry==='recorded')?'recorded':'failed',
        returned_ids:hits.map(r=>r.id)};
    } catch {
      return {...base, status:'error', rank:null};
    }
  });
  const hits = cases.filter(c=>c.status==='hit').length;
  const errors = cases.filter(c=>c.status==='error').length;
  return {suite_version:suite.version, suite_sha256:digest(suite), total:cases.length, hits,
    misses:cases.length-hits-errors, errors, hit_rate:hits/cases.length,
    successful_request_hit_rate:errors===cases.length?null:hits/(cases.length-errors),
    mean_reciprocal_rank:cases.reduce((n,c)=>n+(c.rank?1/c.rank:0),0)/cases.length, cases};
}

// Injectable transport also permits the session's OAuth-connected MCP tools.
export async function runSuite(suite, search) {
  validateSuite(suite);
  const cases=[];
  for (const c of suite.cases) {
    const args={query:c.query,count:c.count,...(c.source?{source:c.source}:{})};
    const row={id:c.id,executed_at:new Date().toISOString()};
    try { row.response=await search(args); } catch { row.error='transport_error'; }
    cases.push(row);
  }
  return {suite_sha256:digest(suite),cases};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [suiteFile,evidenceFile]=process.argv.slice(2);
  if (!suiteFile || !evidenceFile) throw Error('Usage: node eval.mjs suite.json evidence.json');
  const report=score(JSON.parse(await fs.readFile(suiteFile,'utf8')),JSON.parse(await fs.readFile(evidenceFile,'utf8')));
  console.log(JSON.stringify(report,null,2));
  if (report.errors) process.exitCode=2;
}
