import { LEGACY_DEFAULT_PROMPT, PREVIOUS_DEFAULT_PROMPT, PREVIOUS_DEFAULT_MERGED_PROMPT, PRIOR_DEFAULT_PROMPT, PRIOR_DEFAULT_MERGED_PROMPT, PRIOR_MEMORY_PROMPT, PRIOR_MEMORY_MERGED_PROMPT } from './legacy-prompts.js';

export { LEGACY_DEFAULT_PROMPT };

export const PROMPT_STYLE_LABELS = Object.freeze({ traditional: '传统详述', memory: '结构记忆' });

const FACT_RULES = `只写原文能支持、会改变后续对话的事实。人物说法注明是谁说的；计划、承诺和已发生的结果分清。保留有用的姓名、条件、期限、物品归属、秘密的知情范围及末尾仍在进行的事。只记录{{user}}已做的选择。
同一件事只写一次。省去寒暄、走位、反复试探和逐句对白；一句原话只有在措辞本身影响承诺、称谓或线索时才值得保留。输出前删掉重复和无后果的过程。只输出总结正文。`;

const ADD_SCOPE = `为下次接戏写本轮新增记忆。有旧总结时，从它尚未记录的变化写起；重叠原文只用于衔接。旧事有进展或纠正时，用原称谓交代新结果。首次总结按同样标准筛选全部资料，看到本段末尾。整轮正文通常 200–450 字，最多 650 字，没有最低字数。平静的一段可以只用一句话交代最后情形。`;

const MERGE_SCOPE = `把全部可见旧总结和新增资料整理成可独立使用的一份记忆，写入后它将替代旧正文。远期事件只留理解现状所需的因果；仍有效的约定、秘密和未解线索即使近期没提也保留。用最新有据的状态更新旧记录，已经履行或取消的事从待办移出。整份正文通常 500–900 字，最多 1200 字，资料少就短写。接近上限时先合并同一因果链，优先留下会约束下一步的事实。`;

const EVENT_FORMAT = `用 <details><summary>大总结</summary> 开头，以 </details> 收尾。按关键转折分条，每条一两句，写清谁因何做了什么、留下什么结果。时间或地点影响因果时再写。一场谈判即使跨了很多楼，条件和结论也可以合写一条。
另有影响后续的人物身份或关系需要交代时，再附 <details><summary>角色表</summary>，每人一行，仅补正文没有说明的变化，以 </details> 收尾。`;

function structuredMemoryFormat(label) {
    return `用 <details><summary>大总结 · ${label}</summary> 包住整份正文，以 </details> 收尾。从下列栏目中选有独立事实的写，每条一行，空栏目省略：
- 关键转折：把造成现状的决定和结果合写。
- 人物与关系：谁对谁的态度或边界发生了什么变化，依据是什么。
- 约定与线索：责任人、条件或期限、当前进度；未证实的线索保留来源与疑点。
- 知情与约束：谁知道或误解了什么，仍有效的限制是什么。
- 接续状态：在何处、谁持有关键物品、什么动作尚未完成。只补接戏必需的信息。`;
}

export const DEFAULT_PROMPT = [ADD_SCOPE, FACT_RULES, EVENT_FORMAT].join('\n\n');
export const DEFAULT_MERGED_PROMPT = [MERGE_SCOPE, FACT_RULES, EVENT_FORMAT].join('\n\n');
export const MEMORY_PROMPT = [ADD_SCOPE, FACT_RULES, structuredMemoryFormat('新增记忆')].join('\n\n');
export const MEMORY_MERGED_PROMPT = [MERGE_SCOPE, FACT_RULES, structuredMemoryFormat('合并记忆')].join('\n\n');

export function defaultPrompt(style, mode) {
    if (style === 'memory') return mode === 'merged' ? MEMORY_MERGED_PROMPT : MEMORY_PROMPT;
    return mode === 'merged' ? DEFAULT_MERGED_PROMPT : DEFAULT_PROMPT;
}

export function promptTemplates(source, style = source.promptStyle) {
    return style === 'memory' ? source.memoryPrompts : source.prompts;
}

export function migrateDefaultPrompt(value, mode, style = 'traditional') {
    const template = defaultPrompt(style, mode);
    if (value === template) return value;
    const opening = `停止剧情，停止输出其他所有内容，开始执行**${mode === 'merged' ? '全文' : '新增'}大总结**`;
    const normalize = text => text.replace(/\r\n?/g, '\n').trim();
    const previous = mode === 'merged' ? PREVIOUS_DEFAULT_MERGED_PROMPT : PREVIOUS_DEFAULT_PROMPT;
    const previousDefaults = style === 'memory'
        ? [template, mode === 'merged' ? PRIOR_MEMORY_MERGED_PROMPT : PRIOR_MEMORY_PROMPT]
        : [template, mode === 'merged' ? PRIOR_DEFAULT_MERGED_PROMPT : PRIOR_DEFAULT_PROMPT, previous, `${opening}\n\n${previous}`];
    if (style !== 'memory' && mode !== 'merged') previousDefaults.push(LEGACY_DEFAULT_PROMPT);
    const normalized = normalize(value);
    if (!previousDefaults.some(candidate => normalized === normalize(candidate)
        || (style === 'traditional' && normalized === normalize(candidate.replaceAll('{{user}}', '结城爱'))))) return value;
    // Only exact shipped defaults migrate; customized templates stay untouched.
    const newline = value.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    return value.match(/^\s*/)[0] + template.replace(/\r\n?|\n/g, newline) + value.match(/\s*$/)[0];
}

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoEnabled: true,
    streamSummary: true,
    threshold: 60000,
    keepRecent: 20,
    worldBookName: '喵喵大总结世界书',
    depth: 9999,
    mode: 'incremental',
    promptStyle: 'traditional',
    instructionPosition: 'tail',
    instructionDepth: 0,
    instructionRole: 0,
    prompt: DEFAULT_PROMPT,
    apiMode: 'main',
    secondaryUrl: '',
    secondaryKey: '',
    secondaryModel: '',
    secondaryModels: [],
});
