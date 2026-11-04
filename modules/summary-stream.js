import { completionFailure } from './generation-validation.js';

// These native quiet-mode exceptions also apply to a summary-only stream.
export function supportsSummaryStream(payload) {
    return !['o1', 'o1-2024-12-17'].includes(payload.model)
        && !(payload.chat_completion_source === 'workers_ai' && payload.json_schema);
}

export function summaryResponseError(status, body = '') {
    const code = Number(status);
    if (code === 524 || /(?:524\s*:\s*A timeout|error code\s*524|"code"\s*:\s*524)/i.test(body)) {
        return new Error('中转响应超时（HTTP 524）。已收到的正文会暂存，可稍后重试或换用响应更快的模型。');
    }
    if (code === 429) return new Error('接口请求过于频繁或额度不足（HTTP 429），请稍后重试或检查额度。');
    if ([401, 403].includes(code)) return new Error(`接口拒绝访问（HTTP ${code}），请检查连接权限与密钥。`);
    if (code === 400) {
        try {
            const data = JSON.parse(body);
            const detail = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message;
            if (typeof detail === 'string' && detail.trim()) {
                const safe = detail.trim().replace(/[<>]/g, char => char === '<' ? '＜' : '＞')
                    .replace(/Bearer\s+[^\s"']+|\bsk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏密钥]').slice(0, 500);
                return new Error(`总结接口返回 HTTP 400：${safe}`);
            }
        } catch { /* Do not expose HTML proxy pages or an arbitrary response body. */ }
    }
    return new Error(code >= 400 ? `总结接口返回 HTTP ${code}，请检查服务状态。`
        : '总结接口返回错误或无法识别的响应，请检查酒馆后台日志。');
}

const textParts = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(part => !part.thought && ['text', 'output_text', undefined].includes(part.type))
        .map(part => typeof part.text === 'string' ? part.text : '').join('') : '';

// Parse only textual output. Reasoning changes the progress state, never the
// saved text. Keep this independent of the host's current provider selection.
function consumeEvent(state, data, event) {
    if (data?.error || event === 'error' || data?.type === 'error') throw summaryResponseError(data?.error?.code);
    state.failure ||= completionFailure(data);
    const type = data?.type ?? event;
    const choice = data?.choices?.find(choice => choice.index === 0 || choice.index === undefined);
    if (choice) {
        if (choice.delta?.tool_calls || choice.delta?.function_call) state.failure = '模型返回了工具调用，未完成总结';
        if (choice.delta?.refusal) state.failure = '模型未完整返回总结正文';
        if (choice.delta?.reasoning_content || choice.delta?.reasoning
            || choice.delta?.content?.some?.(part => part.type === 'thinking')) state.thinking = true;
        if (choice.delta?.content !== undefined) state.text += textParts(choice.delta.content);
        else if (choice.message?.content !== undefined) state.text = textParts(choice.message.content);
        else if (typeof choice.text === 'string') state.text += choice.text;
        if (choice.finish_reason) state.complete = true;
    } else if (type === 'content_block_start') {
        if (data.content_block?.type === 'tool_use') state.failure = '模型返回了工具调用，未完成总结';
        if (data.content_block?.type === 'text') state.text += data.content_block.text ?? '';
        if (data.content_block?.type === 'thinking') state.thinking = true;
    } else if (type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta') state.text += data.delta.text ?? '';
        if (data.delta?.type === 'thinking_delta') state.thinking = true;
    } else if (type === 'message_delta') {
        state.failure ||= completionFailure({ stop_reason: data.delta?.stop_reason });
        // Anthropic requires message_stop, not just a block or stop reason.
    } else if (type === 'message_stop') {
        state.complete = state.terminal = true;
    } else if (Array.isArray(data?.candidates)) {
        const candidate = data.candidates.find(candidate => candidate.index === 0 || candidate.index === undefined);
        const parts = candidate?.content?.parts ?? [];
        state.text += textParts(parts);
        if (parts.some(part => part.thought)) state.thinking = true;
        if (parts.some(part => part.functionCall)) state.failure = '模型返回了工具调用，未完成总结';
        if (candidate?.finishReason) state.complete = true;
    } else if (type === 'content-delta') {
        state.text += textParts(data.delta?.message?.content?.text);
    } else if (type === 'message-end') {
        state.failure ||= completionFailure({ stop_reason: data.delta?.finish_reason });
        state.complete = state.terminal = true;
    } else if (type === 'tool-call-start') {
        state.failure = '模型返回了工具调用，未完成总结';
    }
}

export async function readSummaryStream(response, { signal, onProgress = () => {}, allowJson = false } = {}) {
    if (!response.body) throw new Error('流式响应没有正文。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { text: '', thinking: false, complete: false, terminal: false, failure: null };
    let buffer = '', event = '', lines = [];
    let format = allowJson ? 'unknown' : 'sse';
    let ended = false;
    const abort = () => { void reader.cancel().catch(() => {}); };
    const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new Error('本次总结已取消。'); };
    const dispatch = () => {
        if (!lines.length) { event = ''; return; }
        const raw = lines.join('\n');
        lines = [];
        if (raw.trim() === '[DONE]') state.complete = state.terminal = true;
        else {
            let data;
            try { data = JSON.parse(raw); }
            catch { throw new Error('流式响应数据不完整或格式异常。'); }
            consumeEvent(state, data, event);
        }
        event = '';
    };
    const consumeLines = (final = false) => {
        while (!state.terminal) {
            const index = buffer.search(/[\r\n]/);
            if (index < 0 || (!final && buffer[index] === '\r' && index === buffer.length - 1)) break;
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + (buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1));
            if (line === '') dispatch();
            else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
            else if (line === 'data') lines.push('');
            else if (line.startsWith('event:')) event = line.slice(6).trim();
        }
    };
    try {
        signal?.addEventListener('abort', abort, { once: true });
        checkAbort();
        while (!state.terminal) {
            const { done, value } = await reader.read();
            checkAbort();
            if (done) {
                ended = true;
                buffer += decoder.decode();
                if (format === 'sse') consumeLines(true);
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            if (format === 'unknown' && buffer.trimStart()) {
                // ST's forwardFetchResponse does not forward Content-Type.
                // Detect the wire format before consuming any event bytes.
                format = /^[\[{<]/.test(buffer.trimStart()) ? 'json' : 'sse';
            }
            if (format === 'sse') consumeLines();
            onProgress({ text: state.text, thinking: state.thinking, lastReceivedAt: Date.now() });
        }
        if (format === 'json') {
            let json;
            try { json = JSON.parse(buffer); }
            catch { throw summaryResponseError(response.status, buffer); }
            if (json?.error) throw summaryResponseError(json.error?.code, buffer);
            return { json };
        }
        // EOF alone is not completion: truncated output must never hide chat.
        if (!state.complete || (!state.terminal && (buffer.trim() || lines.length))) {
            throw new Error('流式连接在完整结束前中断，已收到的正文仅作暂存。');
        }
        return { text: state.text, failure: state.failure };
    } catch (error) {
        // Publish even the last successfully parsed event before a later error.
        onProgress({ text: state.text, thinking: state.thinking, lastReceivedAt: Date.now() });
        throw error;
    } finally {
        signal?.removeEventListener('abort', abort);
        if (!ended) void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
