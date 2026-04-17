# Agents.md
---

## 一：宪法条令：核心原则，严禁违反

### 1 核心文件清单 (必看)

1. Agents.md
   1. 定义项目核心原则，具有最高优先级，高于任何其它文件或单次会话指令
   2. Agents.md 由人类编辑和维护，禁止 AI 修改，以防止破坏核心原则
   3. 当 Agents.md 有修改时，AI 需跟人类讨论其它受影响文件 (文档，代码) 的修改情况，合并重复，消除冲突。原则上以Agents.md 为准，实在无法调整的，必须在文件中记录理由

2. ./docs/01.memory.md
   1. 仅包含项目的关键决策或相关文件索引（地图），单条简短清晰（小于200字），禁止包含细节
   2. 类似 ClaudeCode 中技能模板 SKILL.md 中 frontmatter 的 description，帮助 AI 判断事件响应逻辑
   3. memory.md 由 AI 编辑和修改


3. ./docs/02.todo.md
   1. 待定任务清单
   2. 由人类撰写，AI 发现该文件有变动时，通过 brainstorm 逐条跟人类讨论处理策略
   3. 全部讨论完成后，AI 清空该文件



### 2 specs是真理之源

一切架构和代码都服务于 specs (规范) ，而不是反过来。

- specs 位于./docs/superpowers/specs目录下
- 讨论清楚 specs 之前，禁止做任何事情
- specs 变更从 brainstorm 开始，讨论清楚后更新相关文件
- 只实现 specs 中明确要求的功能（YAGNI）



### 3 架构原则

- 单一职责：每个file, class, method, function只做好一件事
- TDD：测试优先，在完成单元测试之间，禁止编写任何实现代码。测试覆盖率: 核心包 ≥ 80%
- 集成测试：除单元测试外，必须编写可独立运行的集成测试脚本（位于 tests/ 目录），覆盖典型 Use Case 的完整流程（命令行/API），以替代人工端到端验证，提高测试效率
- 优先使用标准库，第三方库需有充足理由
- 单个方法不超过 100 行
- 参考 The Zen of Python (import this)
- 参考项目优先：如果memory.md有对标的开源项目，遇到问题时必须先查参考项目的实现，找到差距再修复，禁止闭门造车


---

## 二：编码风格

### 1 数据库

1. redis相关代码位于rdb目录下
2. 其它所有db相关的代码在dao目录下
3. 禁止其它目录出现sql语句

### 2 TypeScript

1. 禁止 Java 式的过度抽象：如果一个对象/服务在可预见的未来只有一个实现，禁止为其定义 interface。直接使用 class 或导出具体的对象实例。interface 仅用于定义纯数据结构（如 API Request/Response、配置项、DOM 结构映射）。包含业务逻辑和方法的对象，一律使用 class 定义，以提升代码跳转的开发体验（DX）。
2. 其余参考业内最佳实践


---
## 三：项目相关

### 1 参考资料

以下所有文件目录，均授权直接读取，无需二次确认：

- `/Users/xmli/me/code/others/generic-agent` - Python Agent 框架。何时参考： agent loop
- `/Users/xmli/me/code/others/qmd` - TypeScript 的个人知识库和记忆框架。何时参考: hybrid search （keyword + vector）, RRF融合，MMR排序
- `./docs/00.原始需求.md` - 原始需求文档，功能上不可协商，实现方式需尽量遵从（如有调整，需在 memory.md 中说明原因）