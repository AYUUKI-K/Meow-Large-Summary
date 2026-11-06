// Read-only checks at the host's assembly boundary, before template processing.
// No markers are inserted into messages and no extra model request is made.
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function createCoveragePlan(chat) {
    return { chat: [...chat], sources: null, missing: null, observed: false };
}

export function captureCoverageSources(plan, coreChat) {
    if (!plan) return;
    // ST assigns index after filtering system messages, before regex/reasoning
    // and extension interceptors. Hidden tool messages can remain in that list.
    const includesTools = coreChat.some(message => message.is_system);
    const originals = plan.chat.map((message, index) => ({ message, index }))
        .filter(({ message }) => !message.is_system || (includesTools && Array.isArray(message.extra?.tool_invocations)));
    const byIndex = new Map(coreChat.filter(message => Number.isInteger(message.index)).map(message => [message.index, message]));
    plan.sources = originals.flatMap(({ message, index }, coreIndex) => {
        if (message.is_system || !String(message.mes ?? '').trim()) return [];
        const processed = byIndex.get(coreIndex);
        return [{ index, text: processed ? String(processed.mes ?? '') : null }];
    });
}

export function missingCoverage(sources, prompt) {
    if (!sources) return null;
    return createCoverageVerifier(prompt)(sources);
}

// Capture only immutable text, not a clone of the host's whole request (images,
// tool metadata, etc.). Macro fallback can reuse this normalized prompt.
export function createCoverageVerifier(prompt) {
    const content = value => Array.isArray(value)
        ? value.map(part => typeof part === 'string' ? part : part?.text ?? '').join('\n') : String(value ?? '');
    const text = normalize(Array.isArray(prompt) ? prompt.map(message => content(message.content)).join('\n') : prompt);
    return sources => {
        if (!sources) return null;
        let offset = 0;
        const missing = [];
        for (const source of sources) {
            if (source.text === null) { missing.push(source.index); continue; }
            const expected = normalize(source.text);
            // A message intentionally removed by send-time regex has no text to
            // compare. This checks host trimming, not the semantics of that regex.
            if (!expected) continue;
            const start = text.indexOf(expected, offset);
            if (start < 0) missing.push(source.index);
            else offset = start + expected.length;
        }
        return missing;
    };
}

export function thresholdBudgetWarning(threshold, budget) {
    if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(Number(threshold))) return '';
    return Number(threshold) >= budget
        ? `自动阈值 ${Number(threshold).toLocaleString()} token 已达到或超过主连接可用输入预算 ${Math.floor(budget).toLocaleString()} token，可能无法触发。可调低阈值或增大上下文；当前设置不会自动修改。`
        : '';
}
