// Local synthetic benchmark. No user chats, credentials, network or model calls.
// Run from a Git checkout: node scripts/benchmark-history.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as optimized from '../modules/summary-model.js';

const revision = 'd877d3f'; // v1.2.22, before performance changes.
const previous = execFileSync('git', ['show', `${revision}:modules/summary-model.js`], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
});
const baseline = await import(`data:text/javascript;base64,${Buffer.from(previous).toString('base64')}`);
const chat = Array.from({ length: 1200 }, (_, i) => ({ mes: `第${i}层 ${'这是用于检查性能的合成剧情。'.repeat(400)}`,
    name: i % 2 ? '角色' : '用户', is_user: !(i % 2), extra: { reasoning: '' } }));
const records = Array.from({ length: 60 }, (_, i) => ({ round: i + 1, mode: 'incremental', content: `记忆${i}`,
    sourceEnd: (i + 1) * 20 - 1, sourceDigest: baseline.historyDigest(chat, (i + 1) * 20 - 1) }));
assert.deepEqual(optimized.branchRecords(records, chat), baseline.branchRecords(records, chat));
const measure = fn => {
    fn(); // Warm up before taking five samples.
    const samples = Array.from({ length: 5 }, () => { const start = performance.now(); fn(); return performance.now() - start; });
    return Number(samples.sort((a, b) => a - b)[2].toFixed(2));
};
const beforeMs = measure(() => baseline.branchRecords(records, chat));
const afterMs = measure(() => optimized.branchRecords(records, chat));
console.log(JSON.stringify({ baseline: revision, messages: chat.length, summaryRounds: records.length,
    textCharacters: chat.reduce((sum, message) => sum + message.mes.length, 0),
    beforeMedianMs: beforeMs, afterMedianMs: afterMs, speedup: Number((beforeMs / afterMs).toFixed(2)),
    scope: 'Node synthetic history verification only; excludes host prompt assembly, network and model time' }, null, 2));
