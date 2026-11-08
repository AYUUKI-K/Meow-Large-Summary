// Deterministic work-count and format-compatibility checks, not timing thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { branchRecords, createHistoryDigestReader, historyDigest, messageFingerprint,
    sourceChangeAccepted, summarySourceChanged, summaryScope, textDigest } from '../modules/summary-model.js';
import { createCoverageVerifier, missingCoverage } from '../modules/source-coverage.js';

test('batched history reads preserve existing stored fingerprints at every endpoint', () => {
    const chat = Array.from({ length: 120 }, (_, index) => ({ mes: `第${index}层\n喵😺\"\\\t${'剧情'.repeat(index % 7)}`,
        name: index % 2 ? '角色' : '用户', is_user: !(index % 2), swipe_id: index % 3,
        send_date: index % 2 ? null : '2026-11-06', extra: { reasoning: { text: `推理${index}` } } }));
    const read = createHistoryDigestReader(chat);
    // Read backwards and repeat endpoints as older merged records may do.
    for (const end of [119, 0, 59, 119, -1, 120, ...chat.map((_, i) => i)]) {
        const legacy = end < 0 ? textDigest('[]') : end >= chat.length ? null
            : textDigest(JSON.stringify(chat.slice(0, end + 1).map(messageFingerprint)));
        assert.equal(read(end), legacy);
    }
    assert.equal(createHistoryDigestReader([])(), historyDigest([]));
    const sparse = [...chat];
    delete sparse[4];
    assert.equal(createHistoryDigestReader(sparse)(), historyDigest(sparse));
    for (const end of [NaN, 1.5, Infinity, -Infinity]) assert.equal(read(end), historyDigest(chat, end));
});

test('many summary rounds fingerprint each source once, while a new validation catches in-place edits', () => {
    let reads = 0;
    const chat = Array.from({ length: 1000 }, (_, i) => ({ mes: `长剧情${i}`, extra: {
        get reasoning() { reads++; return `思考${i}`; },
    } }));
    const records = Array.from({ length: 50 }, (_, i) => {
        const sourceEnd = (i + 1) * 20 - 1;
        return { round: i + 1, mode: 'incremental', content: `记忆${i}`, sourceEnd, sourceDigest: historyDigest(chat, sourceEnd) };
    });
    reads = 0;
    assert.deepEqual(branchRecords(records, chat), records);
    assert.equal(reads, chat.length, 'work must grow with message count, not rounds × message count');
    chat[25].mes = '同一对象中的旧原文改动';
    assert.deepEqual(branchRecords(records, chat), [records[0]]);
});

test('one source review shares fingerprints for stale memory and its accepted prefix', () => {
    let reads = 0;
    const chat = Array.from({ length: 80 }, (_, i) => ({ mes: `消息${i}`, extra: { get reasoning() { reads++; return ''; } } }));
    const meta = { archiveId: 'archive', round: 1, sourceEnd: 79, sourceDigest: historyDigest(chat) };
    chat[75].mes = '用户已经确认的修改';
    meta.sourceChangeAcknowledgement = { archiveId: 'archive', summaryRound: 1, summarySourceEnd: 79,
        summarySourceDigest: meta.sourceDigest, end: 79, digest: historyDigest(chat) };
    reads = 0;
    const read = createHistoryDigestReader(chat);
    assert.equal(summarySourceChanged(chat, meta, read), true);
    assert.equal(sourceChangeAccepted(chat, meta, read), true);
    assert.equal(reads, 80);
    chat[10].mes = '后来的改动';
    assert.equal(sourceChangeAccepted(chat, meta), false, 'readers cannot leak into later checks');
});

test('single-pass scope agrees with previous visibility boundaries across mixed chats', () => {
    const reference = (chat, keep, cursor, pendingHideEnd) => {
        const keepRecent = Math.max(1, Math.floor(Number(keep) || 1));
        const coveredTo = chat.length - keepRecent - 1;
        const coveredFrom = Math.max(0, cursor + 1);
        const eligible = coveredTo >= coveredFrom && chat.slice(coveredFrom, coveredTo + 1)
            .some(message => !message.is_system && String(message.mes ?? '').trim());
        const range = eligible ? { coveredFrom, coveredTo, keepRecent } : null;
        const hideEnd = Math.max(pendingHideEnd, range?.coveredTo ?? -1);
        const hiddenCount = chat.filter(message => message.is_system).length;
        const pendingCount = chat.filter((message, index) => index <= hideEnd && !message.is_system).length;
        return { range, coveredTo: Math.max(-1, coveredTo), hideEnd, hiddenCount, pendingCount, keptCount: chat.length - hiddenCount - pendingCount,
            recentCount: Math.min(chat.length, keepRecent) };
    };
    for (let n = 0; n < 90; n++) {
        const chat = Array.from({ length: n }, (_, i) => ({ mes: i % 4 ? `剧情${i}` : ' \n', is_system: i % 3 === 0 }));
        for (const keep of [0, 1, 20, 150]) for (const cursor of [-1, 5, n]) for (const pending of [-1, 4, n + 2]) {
            assert.deepEqual(summaryScope(chat, keep, cursor, pending), reference(chat, keep, cursor, pending));
        }
    }
    let bodyReads = 0;
    const long = Array.from({ length: 1000 }, () => ({ get mes() { bodyReads++; return '有效原文'; } }));
    assert.ok(summaryScope(long, 20).range);
    assert.equal(bodyReads, 1, 'finding eligible work must not trim every remaining body');
});

test('gaps keep absolute floor numbers and never consume a retained message slot', () => {
    const chat = new Array(10);
    chat[1] = { mes: 'already hidden', is_system: true };
    chat[4] = { mes: 'old' };
    chat[6] = { mes: 'retained' };
    chat[8] = { mes: 'latest' };
    assert.deepEqual(summaryScope(chat, 2), {
        range: { coveredFrom: 0, coveredTo: 4, keepRecent: 2 }, coveredTo: 4, hideEnd: 4,
        hiddenCount: 1, pendingCount: 1, keptCount: 2, recentCount: 2,
    });
    assert.deepEqual(summaryScope(chat, 2, 4, 6), {
        range: null, coveredTo: 4, hideEnd: 6, hiddenCount: 1, pendingCount: 2, keptCount: 1, recentCount: 2,
    });
    assert.equal(summaryScope(new Array(5), 2).recentCount, 0);
});

test('coverage captures immutable text once and preserves multimodal order and macro fallback', () => {
    let reads = 0;
    const prompt = [{ get content() { reads++; return ['剧情 A', { type: 'image_url', image_url: { url: 'large attachment' } }, { text: '剧情 B' }]; } }];
    const verify = createCoverageVerifier(prompt);
    assert.deepEqual(verify([{ index: 1, text: '剧情 A' }, { index: 2, text: '剧情 B' }]), []);
    const sources = [{ index: 1, text: '{{user}}' }, { index: 2, text: '剧情 B' }];
    assert.deepEqual(verify(sources), [1]);
    sources[0].text = '剧情 A';
    assert.deepEqual(verify(sources), []);
    prompt.length = 0;
    assert.deepEqual(verify(sources), [], 'later host hooks cannot rewrite the captured proof');
    assert.deepEqual(verify([{ index: 3, text: null }, { index: 4, text: 'large attachment' }]), [3, 4]);
    assert.equal(reads, 1);
    assert.equal(missingCoverage(null, 'anything'), null);
});
