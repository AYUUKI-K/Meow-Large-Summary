import { textDigest } from './summary-model.js';

const JOB_STORAGE_PREFIX = 'meow-large-summary-job-v1:';

// Host prompt caches, UI preferences and object property order change on reload.
// Only stable generation choices belong in the resumable task's signature.
export function summaryConnectionSignature(context) {
    const pick = value => Object.entries(value ?? {}).filter(([key, item]) => item !== null
        && ['string', 'number', 'boolean'].includes(typeof item)
        && /model|source|url|^api_type$|max_context|max_tokens|prompt_post_processing|temperature|temp_openai|top_p|top_k|penalty|seed|min_p|typical_p|nsigma/i.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
    return textDigest(JSON.stringify([context.mainApi, pick(context.chatCompletionSettings), pick(context.textCompletionSettings),
        context.name1, context.name2, context.powerUserSettings?.reasoning?.prefix, context.powerUserSettings?.reasoning?.suffix]));
}

export function createSummaryJobStore(storage = () => globalThis.localStorage) {
    const key = id => JOB_STORAGE_PREFIX + encodeURIComponent(id);
    return {
        read(id) {
            const raw = storage().getItem(key(id));
            if (raw === null) return null;
            const job = JSON.parse(raw);
            if (job?.version !== 1 || job.archiveId !== id || typeof job.id !== 'string'
                || typeof job.signature !== 'string' || !Number.isInteger(job.sourceEnd) || job.sourceEnd < -1
                || !['summary', 'compact', 'compress', 'rebuild'].includes(job.operation)
                || ![null, 'incremental', 'merged'].includes(job.modeOverride)
                || !Array.isArray(job.steps) || job.steps.some(step => typeof step?.key !== 'string' || typeof step?.text !== 'string')
                || (job.result !== null && typeof job.result !== 'string')) throw new Error('总结进度无法读取，请放弃此进度后重试。');
            return job;
        },
        write(job) { storage().setItem(key(job.archiveId), JSON.stringify(job)); },
        remove(id) { storage().removeItem(key(id)); },
    };
}

// Keep real floor labels; a single oversized message is split without discarding
// text, preferably at a paragraph boundary. Never modify the host chat to batch.
export async function splitSummarySources(sources, fits, check = () => {}) {
    const chunks = [];
    const visit = async group => {
        check();
        if (!group.length) return;
        const full = group.map(source => `【${source.label}】\n${source.text}`).join('\n\n');
        if (await fits(full)) { chunks.push(full); return; }
        if (group.length > 1) {
            // Split groups by text size, avoiding one tokenizer request per
            // floor in a chat with thousands of short messages.
            const target = full.length / 2;
            let size = 0, end = 0;
            while (end < group.length - 1 && size < target) {
                size += group[end].text.length + group[end].label.length + 5;
                end++;
            }
            await visit(group.slice(0, end));
            await visit(group.slice(end));
            return;
        }
        const source = group[0];
        let remaining = source.text;
        let part = 1;
        while (remaining) {
            check();
            const header = `【${source.label}${part > 1 ? ` · 续 ${part}` : ''}】\n`;
            if (await fits(header + remaining)) { chunks.push(header + remaining); break; }
            check();
            let low = 0, high = remaining.length;
            while (low < high) {
                check();
                const mid = Math.ceil((low + high) / 2);
                if (await fits(header + remaining.slice(0, mid))) low = mid;
                else high = mid - 1;
            }
            if (!low) throw new Error('总结模板已占满可用输入空间，请缩短模板或增大上下文。');
            let end = low;
            const paragraph = remaining.lastIndexOf('\n', low - 1);
            if (paragraph > low / 2) end = paragraph + 1;
            // Do not bisect a UTF-16 surrogate pair.
            if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
            if (!end) throw new Error('可用输入空间不足以容纳原文，请增大上下文。');
            chunks.push(header + remaining.slice(0, end));
            remaining = remaining.slice(end);
            part++;
        }
    };
    await visit(sources.filter(source => source.text.trim()));
    return chunks;
}

// Cache only complete, validated responses. Partial streams stay in the existing
// draft store. Retrying save or a later segment never regenerates earlier steps.
export async function generateSummaryJob({ job, sources, background = '', merge, combineNewSegments = false, promptFor, count,
    budget, generate, nativeGenerate, save, check = () => {}, progress = () => {} }) {
    if (job.result) return job.result;
    const counts = new Map();
    const fits = async (text, merging = false) => {
        check();
        const prompt = promptFor(text, merging);
        const key = textDigest(prompt);
        const tokens = counts.has(key) ? counts.get(key) : await count(prompt);
        counts.set(key, tokens);
        check();
        if (!Number.isFinite(tokens) || tokens < 0) throw new Error('无法计算分段输入长度，请检查 tokenizer。');
        return tokens <= budget;
    };
    const complete = async (prompt, label, native = false) => {
        check();
        const key = textDigest(`${native ? 'native' : 'source'}\n${prompt}`);
        const saved = job.steps.find(step => step.key === key);
        if (saved) return saved.text;
        progress(label);
        const text = String(await (native ? nativeGenerate() : generate(prompt))).trim();
        check();
        if (!text) throw new Error('模型没有返回完整总结，已保留此前进度。');
        job.steps.push({ key, text });
        save(job);
        return text;
    };
    const all = sources.map(source => `【${source.label}】\n${source.text}`).join('\n\n');
    // Avoid tokenizer calls on small ordinary summaries. UTF-8 byte length is
    // bounded by three bytes per UTF-16 code unit (including surrogate pairs).
    const small = (all.length + background.length + promptFor('').length) * 3 <= budget;
    if (nativeGenerate && (small || await fits(background + '\n\n' + all))) {
        job.result = await complete(job.signature, '生成总结', true);
    } else {
        job.segmented = true;
        save(job);
        const chunks = await splitSummarySources(sources, fits, check);
        job.total = chunks.length;
        save(job);
        let results = [];
        for (const [index, chunk] of chunks.entries()) {
            results.push(await complete(promptFor(chunk), `第 ${index + 1}/${chunks.length} 段`));
        }
        if (merge && background.trim()) results.unshift(background);
        if (!results.length) throw new Error('没有可用于分段总结的原文。');
        if (merge || (combineNewSegments && results.length > 1)) {
            // Reduce in bounded groups; never put an unbounded collection back
            // into one request. Refuse non-converging model output, retaining it.
            for (let round = 0; results.length > 1 || !await fits(results[0], true); round++) {
                if (round >= 6) throw new Error('分段结果仍过长，请精简总结模板后重新开始；已完成正文保留。');
                const label = merge ? '已有总结' : '本轮笔记';
                const groups = await splitSummarySources(results.map((text, index) => ({ label: `${label} ${index + 1}`, text })), text => fits(text, true), check);
                const next = [];
                for (const [index, group] of groups.entries()) {
                    next.push(await complete(promptFor(group, true), `合并结果 ${index + 1}/${groups.length}`));
                }
                results = next;
            }
        }
        job.result = results.join('\n\n');
    }
    check();
    save(job);
    return job.result;
}
