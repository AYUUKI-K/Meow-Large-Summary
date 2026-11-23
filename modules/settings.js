import { LEGACY_DEFAULT_PROMPT, PREVIOUS_DEFAULT_PROMPT, PREVIOUS_DEFAULT_MERGED_PROMPT, PRIOR_DEFAULT_PROMPT, PRIOR_DEFAULT_MERGED_PROMPT, PRIOR_MEMORY_PROMPT, PRIOR_MEMORY_MERGED_PROMPT } from './legacy-prompts.js';

export { LEGACY_DEFAULT_PROMPT };

export const PROMPT_STYLE_LABELS = Object.freeze({ traditional: '传统详述', memory: '结构记忆', chronicle: '纪实详述 @KKM' });
// 编辑器里多一个「压缩」；运行模式仍只有新增 / 合并两种。
export const TEMPLATE_MODES = Object.freeze(['incremental', 'merged', 'compress']);

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

// 纪实详述（@KKM）：按时间线记事件，另附主要角色、伏笔人物、伏笔清单与重要记忆锚点。
const CHRONICLE_CORE = `【核心要求】
- 大总结任务是在保持故事连贯、逻辑合理的前提下，对记忆的梳理和压缩，让后续接手任务的AI能顺利继续
- 确认区分重要和次要的，保留近期or重要的，舍弃远期or不重要的`;

const CHRONICLE_RULES = (scope, counts) => `【规则】
- **思考围绕${scope}、提炼，不做其他思考**
- 每项内容在大总结内只出现一次，避免重复记录
- 第三人称全知视角，按时间或逻辑顺序客观纪实；提到用户一律写「{{user}}」
- 直接陈述事实，不评价、不修饰、不升华；不回避任何敏感内容，如实记录
- 说法注明来源；计划、承诺和已经发生的结果分开写；秘密写明谁知道、谁不知道
- 保留重要的约定、物品、事件和情感发展
- NSFW 剧情概括地写，不丢核心，重点写它给关系带来的质变；${counts}
- 避免剧透
- 无需加粗标注`;

const CHRONICLE_END = '**本回合只输出大总结：不写正文，不输出摘要、小总结、选项、小剧场等其他任何模块。**';

export const CHRONICLE_MERGED_PROMPT = `停止剧情，暂停其他所有输出规则，开始执行**全文大总结**。必须客观、纪实，专注总结任务。

${CHRONICLE_CORE}

【任务】
- 回溯全部上文，包括之前所有的大总结
- 大总结只记录历史故事和以前大总结的内容，人设、档案内的内容为了避免重复不记录
- 有之前的大总结时，合并成一份新的、唯一的总结：仍然有效的约定、秘密和伏笔保留
- 上文有摘要/小总结时，以其为线索理清顺序，以正文为准补足细节；仍有影响的人或物要保留
- 详略得当：越久远越精简合并
- 注明这是第几次大总结：在上文找到最近一份大总结，序号加 1；找不到就是第 1 次

${CHRONICLE_RULES('大总结', '记录累计的亲密次数')}

【输出格式】
<details><summary>第N次大总结｜回合 No.001–No.XXX｜剧中时间起止</summary>

## 事件时间线
- 日期 时间：流水账模式记录事件，越远的事件越概括，特别久远的可以多件事一起概述。
  - 关键对话 / 内心戏（标明角色，选填）：
  - 关系变化（选填）：
  - 角色成长（选填）：{{user}}以外的角色在内心或行为上的变化
……

## 主要角色更新（无需记录{{user}}）
- 姓名｜身份｜当前状态｜与{{user}}的关系｜剧情中已确立的设定

## 伏笔人物记录
- 姓名｜身份｜一句话描述伏笔人物的记忆锚点（只出现过一次的角色和路人不列）

## 关键伏笔清单
- 尚未揭示或解决的伏笔、约定、悬念：内容｜谁知道｜目前进展（只作记录，后续剧情不必刻意回收）

## 重要记忆锚点
- 日期｜纪念日、初次、誓言、特殊物品、关键原话等必须长期记住的事（只精选重要的，久远的可以合并）

</details>

全文通常 2000–5000 字，最多不超过 8000 字。

${CHRONICLE_END}`;

export const CHRONICLE_PROMPT = `停止剧情，暂停其他所有输出规则，开始执行**新增大总结**。必须客观、纪实，专注总结任务。

${CHRONICLE_CORE}

【任务】
- 只总结上次大总结之后的新增剧情：从上一份大总结记到的时间（回合）之后写起，重叠的部分只用来衔接，不重复记录
- 大总结只记录历史故事，人设、档案内的内容为了避免重复不记录
- 旧事有了进展或被推翻时，用原来的称呼交代新结果
- 上文有摘要/小总结时，以其为线索理清顺序，以正文为准补足细节；仍有影响的人或物要保留
- 注明这是第几次大总结：在上文找到最近一份大总结，序号加 1；找不到就是第 1 次

${CHRONICLE_RULES('大总结', '记录本段的亲密次数和累计次数')}

【输出格式】
<details><summary>第N次大总结｜回合 No.起–No.止｜剧中时间起止</summary>

## 事件时间线
- 日期 时间：流水账模式记录本段新增的事件。
  - 关键对话 / 内心戏（标明角色，选填）：
  - 关系变化（选填）：
  - 角色成长（选填）：{{user}}以外的角色在内心或行为上的变化
……

## 主要角色更新（无需记录{{user}}）
- 只写本段新出场或有变化的：姓名｜身份｜当前状态｜与{{user}}的关系｜剧情中已确立的设定

## 伏笔人物记录
- 本段新出现的：姓名｜身份｜一句话描述伏笔人物的记忆锚点（只出现过一次的角色和路人不列）

## 关键伏笔清单
- 本段新埋下、有进展或已经解决的伏笔、约定、悬念（已解决的注明）：内容｜谁知道｜目前进展（只作记录，后续剧情不必刻意回收）

## 重要记忆锚点
- 本段新增：日期｜纪念日、初次、誓言、特殊物品、关键原话等必须长期记住的事（只精选重要的）

</details>

篇幅随新增剧情多少而定，通常 600–2000 字。

${CHRONICLE_END}`;

export const CHRONICLE_COMPRESS_PROMPT = `停止剧情，暂停其他所有输出规则，开始执行**压缩大总结**。必须客观、纪实，专注压缩任务。

【核心要求】
- 压缩是在保持故事连贯、逻辑合理的前提下，对已有大总结的再提炼，让后续接手任务的AI能顺利继续
- 确认区分重要和次要的，保留近期or重要的，舍弃远期or不重要的

【任务】
- 资料是一份已有的大总结（可能由几次总结拼成）。把它压缩成一份新的、唯一的大总结，篇幅按任务说明里的目标
- 只做删减与合并，不加入资料里没有的事，不推测，不改写事实
- 大总结只记录历史故事和以前大总结的内容，人设、档案内的内容为了避免重复不记录
- 注明这是第几次大总结（压缩）：沿用资料里最新的序号

【保留顺序：越靠前越不能丢】
1. 重要记忆锚点
2. 仍然有效的约定、秘密（谁知道、谁不知道）、未解决的伏笔
3. 主要角色的当前状态、与{{user}}的关系、已确立的设定
4. 近期事件的起因、经过、结果
5. 远期事件：按阶段合并成「日期范围｜一两句因果」，删去对话、内心戏和过程

【可以删掉的】
- 已经履行或取消的约定、已经解决的伏笔（对现状有影响的结果，并进事件里一句带过）
- 不再出场、对现状没有影响的人物
- 重复的叙述

${CHRONICLE_RULES('压缩', '只留累计的亲密次数')}

【输出格式】
<details><summary>第N次大总结（压缩）｜回合 No.001–No.XXX｜剧中时间起止</summary>

## 事件时间线
- 远期阶段：日期范围｜一两句因果
- 日期 时间：近期事件，流水账记录。
  - 关系变化（选填）：
  - 角色成长（选填）：{{user}}以外的角色在内心或行为上的变化
……

## 主要角色更新（无需记录{{user}}）
- 姓名｜身份｜当前状态｜与{{user}}的关系｜剧情中已确立的设定

## 伏笔人物记录
- 姓名｜身份｜一句话描述伏笔人物的记忆锚点

## 关键伏笔清单
- 仍未解决的：内容｜谁知道｜目前进展（只作记录，后续剧情不必刻意回收）

## 重要记忆锚点
- 日期｜事件（只精选重要的，久远的可以合并）

</details>

**本回合只输出压缩后的大总结：不写正文，不输出摘要、小总结、选项、小剧场等其他任何模块。**`;

// 传统详述、结构记忆共用的压缩模板：沿用原总结的格式。
export const COMPRESS_PROMPT = `把资料中的已有总结压缩成一份新的、唯一的总结，篇幅按任务说明里的目标。保留原总结的格式、栏目和标签（例如 <details><summary>…</summary> 的包裹）。只做删减与合并，不加入资料以外的事，不推测，不改写事实；提到用户一律写{{user}}。

保留顺序（越靠前越不能丢）：必须长期记住的事（誓言、纪念日、关键物品、关键原话）；仍有效的约定、承诺和秘密的知情范围；人物当前状态与关系；末尾仍在进行的事；近期事件的因果；远期事件只留理解现状所需的因果，可按阶段合并成一两句。

已经履行或取消的事、不再影响后续的人物和重复叙述可以删去。只输出压缩后的总结正文。`;

export const DEFAULT_PROMPT = [ADD_SCOPE, FACT_RULES, EVENT_FORMAT].join('\n\n');
export const DEFAULT_MERGED_PROMPT = [MERGE_SCOPE, FACT_RULES, EVENT_FORMAT].join('\n\n');
export const MEMORY_PROMPT = [ADD_SCOPE, FACT_RULES, structuredMemoryFormat('新增记忆')].join('\n\n');
export const MEMORY_MERGED_PROMPT = [MERGE_SCOPE, FACT_RULES, structuredMemoryFormat('合并记忆')].join('\n\n');

export function defaultPrompt(style, mode) {
    if (style === 'chronicle') return mode === 'compress' ? CHRONICLE_COMPRESS_PROMPT : mode === 'merged' ? CHRONICLE_MERGED_PROMPT : CHRONICLE_PROMPT;
    if (mode === 'compress') return COMPRESS_PROMPT;
    if (style === 'memory') return mode === 'merged' ? MEMORY_MERGED_PROMPT : MEMORY_PROMPT;
    return mode === 'merged' ? DEFAULT_MERGED_PROMPT : DEFAULT_PROMPT;
}

export function promptTemplates(source, style = source.promptStyle) {
    if (style === 'chronicle') return source.chroniclePrompts;
    return style === 'memory' ? source.memoryPrompts : source.prompts;
}

export function migrateDefaultPrompt(value, mode, style = 'traditional') {
    const template = defaultPrompt(style, mode);
    if (value === template) return value;
    // 纪实详述和各风格的压缩模板是 1.6.0 新增的，没有旧默认要迁移。
    if (style === 'chronicle' || mode === 'compress') return value;
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
    // 单次总结输入上限：safe = min(24000, 主连接上限 × 70%)；context = 主连接上限 × 70%；custom = inputCapTokens（仍不超过 70%）
    inputCap: 'safe',
    inputCapTokens: 100000,
    compressTarget: 5000,
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
