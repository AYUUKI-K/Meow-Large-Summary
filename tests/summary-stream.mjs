import test from 'node:test';
import assert from 'node:assert/strict';
import { readSummaryStream, summaryResponseError, supportsSummaryStream } from '../modules/summary-stream.js';
import { taskLabel } from '../modules/task-state.js';

const event = (data, name = '') => `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (content, extra = {}) => ({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });
const response = (text, size = 7) => {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(offset, offset += size));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
};

test('OpenAI stream handles split UTF-8, CRLF, comments, reasoning, usage and DONE', async () => {
    const packets = [];
    const raw = ': heartbeat\n\n' + event(delta('', { reasoning_content: '私有推理' }))
        + event(delta('约定在')) + event(delta('北门见面🐈。')) + event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + event({ choices: [], usage: { completion_tokens: 20 } }) + event('[DONE]');
    const result = await readSummaryStream(response(raw.replaceAll('\n', '\r\n'), 1), { onProgress: p => packets.push(p) });
    assert.equal(result.text, '约定在北门见面🐈。');
    assert.equal(result.failure, null);
    assert.ok(packets.some(p => p.thinking));
    assert.ok(packets.some(p => p.text.length > 0 && p.text.length < result.text.length));
});

test('SSE supports CR-only and multiline data', async () => {
    const raw = 'data: {"choices":\rdata: [{"delta":{"content":"正文"}}]}\r\rdata: [DONE]\r\r';
    assert.equal((await readSummaryStream(response(raw, 1))).text, '正文');
});

test('native ST proxy without content-type is still read incrementally', async () => {
    let updates = 0;
    const proxied = response(event(delta('第一段')) + event(delta('第二段')) + event('[DONE]'), 9);
    proxied.headers.delete('Content-Type');
    const result = await readSummaryStream(proxied, { allowJson: true, onProgress: p => { if (p.text === '第一段') updates++; } });
    assert.equal(result.text, '第一段第二段');
    assert.ok(updates > 0);
});

test('stream-compatible service returning JSON is accepted without a retry', async () => {
    const json = { choices: [{ message: { content: '完整正文' }, finish_reason: 'stop' }] };
    assert.deepEqual(await readSummaryStream(response(JSON.stringify(json), 3), { allowJson: true }), { json });
});

test('HTTP-200 proxy HTML and JSON errors produce concise transport errors', async () => {
    await assert.rejects(readSummaryStream(response('<title>relay | 524: A timeout occurred</title>'), { allowJson: true }), /HTTP 524/);
    await assert.rejects(readSummaryStream(response('{"error":{"code":429}}'), { allowJson: true }), /HTTP 429/);
});

test('Anthropic block and message events exclude thinking and require message_stop', async () => {
    const raw = event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '私有推理' } })
        + event({ type: 'content_block_start', content_block: { type: 'text', text: '人物' } })
        + event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '达成约定。' } })
        + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    await assert.rejects(readSummaryStream(response(raw)), /完整结束前中断/);
    assert.deepEqual(await readSummaryStream(response(raw + event({ type: 'message_stop' }))), { text: '人物达成约定。', failure: null });
});

test('Gemini separates thoughts, collects every text part, and accepts a final finishReason', async () => {
    const raw = event({ candidates: [{ index: 0, content: { parts: [{ thought: true, text: '私有推理' }, { text: '前往' }, { text: '北门。' }] } }] })
        + event({ candidates: [{ index: 0, finishReason: 'STOP' }] });
    assert.equal((await readSummaryStream(response(raw))).text, '前往北门。');
});

test('Cohere collects content deltas and observes message-end', async () => {
    const raw = event({ type: 'content-delta', delta: { message: { content: { text: '归还信件。' } } } })
        + event({ type: 'message-end', delta: { finish_reason: 'COMPLETE' } });
    assert.equal((await readSummaryStream(response(raw))).text, '归还信件。');
});

for (const [name, frame] of [
    ['output limit', { choices: [{ delta: { content: '正文' }, finish_reason: 'length' }] }],
    ['safety', { candidates: [{ finishReason: 'SAFETY' }] }],
    ['tool calls', delta('', { tool_calls: [{ id: 'call-a' }] })],
    ['refusal', delta('', { refusal: '拒绝' })],
    ['Anthropic output limit', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }],
]) {
    test(`${name} is rejected even when a normal stream terminator follows`, async () => {
        const result = await readSummaryStream(response(event(frame) + event('[DONE]')));
        assert.ok(result.failure);
    });
}

for (const [name, tail] of [['EOF', ''], ['malformed event', 'data: {broken}\n\n'],
    ['provider error', event({ error: { code: 524 } })], ['unfinished frame', 'data: {"choices":']]) {
    test(`${name} preserves parsed partial text without claiming success`, async () => {
        let partial;
        await assert.rejects(readSummaryStream(response(event(delta('已收到的正文')) + tail), { onProgress: value => { partial = value; } }));
        assert.equal(partial.text, '已收到的正文');
    });
}

test('cancel releases a stalled reader and retains text already received', async () => {
    const controller = new AbortController();
    let closed = false, partial;
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event(delta('暂存内容')))); }, cancel() { closed = true; } });
    const pending = readSummaryStream(new Response(stream), { signal: controller.signal, onProgress: value => {
        partial = value;
        controller.abort();
    } });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(partial.text, '暂存内容');
    assert.equal(closed, true);
});

test('unrelated choices and reasoning-only chunks never become saved text', async () => {
    const raw = event({ choices: [{ index: 1, delta: { content: '错误分支' } }] })
        + event(delta('', { reasoning_content: '思考' })) + event('[DONE]');
    assert.equal((await readSummaryStream(response(raw))).text, '');
});

test('known nonstreaming models and Workers JSON schema remain nonstreaming', () => {
    assert.equal(supportsSummaryStream({ model: 'o1' }), false);
    assert.equal(supportsSummaryStream({ chat_completion_source: 'workers_ai', json_schema: {} }), false);
    assert.equal(supportsSummaryStream({ model: 'custom-chat' }), true);
});

test('524 HTML is summarized without exposing raw HTML', () => {
    const error = summaryResponseError(200, '<title>relay | 524: A timeout occurred</title>');
    assert.match(error.message, /HTTP 524/);
    assert.doesNotMatch(error.message, /title|relay/);
});

test('HTTP 400 retains the provider reason without interpreting HTML or exposing a bearer key', () => {
    const error = summaryResponseError(400, JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
    assert.match(error.message, /HTTP 400.*maximum context length exceeded/);
    const hostile = summaryResponseError(400, JSON.stringify({ message: '<img src=x onerror=alert(1)> Bearer sk-secret-key123' }));
    assert.doesNotMatch(hostile.message, /<|sk-secret-key123/);
    assert.doesNotMatch(summaryResponseError(400, '<html>proxy failure</html>').message, /html|proxy/);
});

test('progress distinguishes waiting, thinking, received text, and idle time', () => {
    const task = { stage: 'generating', startedAt: Date.now() - 22000, stream: { enabled: true, chars: 0, startedAt: Date.now() - 21000 } };
    assert.match(taskLabel(task), /等待响应.*未收到新数据/);
    Object.assign(task.stream, { thinking: true, lastReceivedAt: Date.now() });
    assert.match(taskLabel(task), /模型思考中/);
    task.stream.chars = 1234;
    assert.match(taskLabel(task), /接收正文 · 1,234 字/);
});
