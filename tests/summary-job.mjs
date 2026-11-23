import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryJobStore, generateSummaryJob, splitSummarySources, summaryConnectionSignature } from '../modules/summary-job.js';
import { createIdleWatchdog } from '../modules/network.js';

const newJob = () => ({ version: 1, id: 'task-a', archiveId: 'a', signature: 'source-v1', sourceEnd: 12,
    operation: 'summary', modeOverride: null, steps: [], result: null });
const options = job => ({ job, sources: Array.from({ length: 5 }, (_, index) => ({ label: `第 ${index * 3} 层`, text: String(index).repeat(70) })),
    merge: false, promptFor: text => `SUMMARY\n${text}`, count: async text => text.length, budget: 120,
    save() {}, generate: async prompt => `result-${prompt.match(/第 (\d+) 层/)[1]}` });

test('resume signatures survive host prompt caches, UI changes and property reorder, but track model and sampler changes', () => {
    const context = {mainApi:'openai',chatCompletionSettings:{custom_model:'model-a',custom_url:'https://example.test',temp_openai:1},
        powerUserSettings:{font_scale:1},extensionPrompts:{authorNote:{value:'cached'}}};
    const signature = summaryConnectionSignature(context);
    context.chatCompletionSettings = {temp_openai:1,custom_url:'https://example.test',custom_model:'model-a',model_list:['cached']};
    context.powerUserSettings.font_scale = 2;
    context.extensionPrompts = {quietPrompt:{value:'temporary'}};
    assert.equal(summaryConnectionSignature(context), signature);
    context.chatCompletionSettings.custom_model = 'model-b';
    assert.notEqual(summaryConnectionSignature(context), signature);
    context.chatCompletionSettings.custom_model = 'model-a';
    context.chatCompletionSettings.temp_openai = 0.5;
    assert.notEqual(summaryConnectionSignature(context), signature);
});

test('oversized Unicode floors split without losing text, floor gaps or surrogate pairs', async () => {
    const sources = [{ label: '第 0 层', text: '甲\n乙😀'.repeat(51) }, { label: '第 9 层', text: '最终事件' }];
    const chunks = await splitSummarySources(sources, async text => text.length <= 63);
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every(chunk => chunk.length <= 63 && chunk.isWellFormed()));
    assert.equal(chunks.join('\n\n').replace(/【第 (?:0|9) 层(?: · 续 \d+)?】\n/g, '').replace(/\n/g, ''),
        sources.map(source => source.text).join('').replace(/\n/g, ''));
    assert.ok(chunks.at(-1).includes('第 9 层'));
});

test('interrupted segment resumes from persisted completed steps without committing a partial result', async () => {
    const storage = new Map();
    const store = createSummaryJobStore(() => ({ getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }));
    const job = newJob();
    let calls = 0;
    const first = options(job);
    await assert.rejects(generateSummaryJob({ ...first, save: value => store.write(value), generate: async prompt => {
        if (++calls === 3) throw new Error('connection stopped');
        return first.generate(prompt);
    } }), /connection stopped/);
    assert.equal(job.result, null);
    assert.equal(store.read('a').steps.length, 2);
    const loaded = store.read('a');
    const continued = options(loaded);
    calls = 0;
    const result = await generateSummaryJob({ ...continued, generate: async prompt => { calls++; return continued.generate(prompt); } });
    assert.equal(calls, 3);
    assert.equal(result, 'result-0\n\nresult-3\n\nresult-6\n\nresult-9\n\nresult-12');
    assert.equal(await generateSummaryJob({ ...continued, generate: () => { throw new Error('must reuse'); } }), result);
});

test('merge inputs remain bounded through multiple reduction passes', async () => {
    const job = newJob();
    const opts = options(job);
    const prompts = [];
    const result = await generateSummaryJob({ ...opts, merge: true, background: 'old memory',
        generate: async prompt => { prompts.push(prompt); return `memory-${prompts.length}`; } });
    assert.ok(prompts.length > 5);
    assert.ok(prompts.every(prompt => prompt.length <= opts.budget));
    assert.ok(prompts.some(prompt => prompt.includes('old memory')));
    assert.match(result, /^memory-/);
});

test('non-shrinking merge responses stop after bounded passes with completed work intact', async () => {
    const job = newJob();
    await assert.rejects(generateSummaryJob({ ...options(job), merge: true,
        generate: async () => 'result '.repeat(12) }), /仍过长/);
    assert.equal(job.result, null);
    assert.ok(job.steps.length > 0);
});

test('incremental consolidation only combines this round and leaves old memory out of the generated addition', async () => {
    const opts = options(newJob());
    const notes = [];
    const result = await generateSummaryJob({ ...opts, combineNewSegments: true, background: '旧记忆：钥匙原由白露保管',
        generate: async prompt => {
            assert.ok(!prompt.includes('旧记忆'));
            if (prompt.includes('【本轮笔记 1】')) {
                assert.ok(notes.every(note => prompt.includes(note)));
                return '白露把钥匙交给沈岸，约定明早归还。';
            }
            const note = await opts.generate(prompt);
            notes.push(note);
            return note;
        } });
    assert.equal(notes.length, 5);
    assert.equal(result, '白露把钥匙交给沈岸，约定明早归还。');
});

test('failed incremental consolidation keeps the notes and resumes without regenerating sources', async () => {
    const job = newJob();
    const opts = options(job);
    await assert.rejects(generateSummaryJob({ ...opts, combineNewSegments: true, generate: async prompt => {
        if (prompt.includes('【本轮笔记 1】')) throw new Error('consolidation interrupted');
        return opts.generate(prompt);
    } }), /consolidation interrupted/);
    assert.equal(job.steps.length, 5);
    assert.equal(job.result, null);
    let calls = 0;
    const result = await generateSummaryJob({ ...opts, combineNewSegments: true, generate: async prompt => {
        assert.ok(prompt.includes('【本轮笔记 1】'));
        calls++;
        return 'one addition';
    } });
    assert.equal(calls, 1);
    assert.equal(result, 'one addition');
});

test('small tasks retain the native request and retry saved complete output without model calls', async () => {
    const job = newJob();
    let calls = 0;
    const opts = { ...options(job), sources: [{ label: '第 0 层', text: 'story' }], budget: 1000,
        nativeGenerate: async () => { calls++; return 'complete summary'; } };
    assert.equal(await generateSummaryJob(opts), 'complete summary');
    assert.equal(await generateSummaryJob(opts), 'complete summary');
    assert.equal(calls, 1);
    assert.equal(job.segmented, undefined);
});

test('unreadable saved progress is reported, never silently overwritten', () => {
    const store = createSummaryJobStore(() => ({ getItem: () => '{broken', setItem() { throw new Error('must not write'); } }));
    assert.throws(() => store.read('a'));
});

test('thousands of short floors are planned in groups instead of one tokenizer call per floor', async () => {
    const sources = Array.from({length:3000}, (_, index) => ({label:`第 ${index} 层`,text:'剧情'.repeat(100)}));
    let counts = 0;
    const chunks = await splitSummarySources(sources, async text => { counts++; return text.length <= 24000; });
    assert.ok(chunks.length > 10);
    assert.ok(counts < 150, `unexpected tokenizer work: ${counts}`);
    assert.ok(chunks.every(chunk => chunk.length <= 24000));
});

test('idle watchdog can be refreshed and disposed, and fires only on silent requests', async () => {
    let timedOut = false;
    const timer = createIdleWatchdog(() => { timedOut = true; }, 25);
    await new Promise(resolve => setTimeout(resolve, 10));
    timer.touch();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(timedOut, false);
    timer.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(timedOut, false);
    const error = await new Promise(resolve => createIdleWatchdog(resolve, 10));
    assert.equal(error.name, 'TimeoutError');
});
