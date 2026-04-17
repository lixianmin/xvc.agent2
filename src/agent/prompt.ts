import type { ToolDef } from '../llm/client';

export function buildSystemPrompt(params: {
  tools: ToolDef[];
  userName: string;
  aiNickname?: string;
  ragContext?: string;
  datetime: string;
  systemPromptExtra?: string;
}): string {
  const sections: string[] = [];

  sections.push(`# 可用工具

你可以使用以下工具：
${JSON.stringify(params.tools, null, 2)}`);

  sections.push(`# 基本指令

你是一个智能任务管理助手。

## 核心能力
- 任务管理：创建、查询、更新、删除任务
- 网络搜索：搜索互联网获取最新信息
- 文件管理：管理用户上传的文件和文档
- 文档检索：从用户上传的文档中检索相关信息

## 行为准则
- 回复简洁明了，直奔主题
- 主动使用工具完成任务，不要只是描述如何做
- 使用用户使用的语言回复
- 如果信息不足，主动提问或搜索补充

## 深度研究
对于复杂问题，请按以下步骤处理：
1. 将问题分解为若干子问题
2. 逐一搜索每个子问题
3. 综合所有结果，给出带引用的完整回答`);

  let userSection = `# 用户信息\n\n用户名：${params.userName}`;
  if (params.aiNickname) {
    userSection += `\n你的昵称：${params.aiNickname}`;
  }
  sections.push(userSection);

  if (params.ragContext) {
    sections.push(`## 相关文档
以下是从用户上传的文档中检索到的相关内容：
${params.ragContext}`);
  }

  if (params.systemPromptExtra) {
    sections.push(params.systemPromptExtra);
  }

  sections.push(`# 当前时间\n\n${params.datetime}`);

  return sections.join('\n\n');
}
