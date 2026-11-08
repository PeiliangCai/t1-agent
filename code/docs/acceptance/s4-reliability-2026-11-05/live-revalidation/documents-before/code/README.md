# T1 论文原文工作台

正式前端统一为 `apps/pi-web/` 的 Next.js 应用，以 [agegr/pi-web](https://github.com/agegr/pi-web/tree/f130910abf662b506b2ef2f475fc21a2fe57badc) 0.15.0 为基础。固定上游完整源码压缩包、1209 项文件指纹及三份常用基线（MIT 许可证、README、package.json）保存在 `third_party/pi-web/`；运行副本保留原标签页、整图预览、主题、导航菜单与面板调整组件。Fastify、SQLite/SSE 和 T1 受限 Pi SDK 1.4.0 保留，前端依赖独立安装。

所有命令从本目录 `code/` 执行；项目根目录的 `AGENTS.md` 继续适用。现行开发范围和执行顺序以根目录 [T1 主开发计划](../方案/子任务T1/T1智能体开发计划.docx) 与 [开发执行说明](../方案/子任务T1/T1开发执行说明.docx) 为准；工程证据在 `docs/acceptance/`。

## 本次两轮真实复验

当前使用 [两轮真实复验对照（只读）](apps/pi-web/public/output-review/revalidation.html)。VSCode远程打开 `apps/pi-web/public/output-review/` 整个文件夹，右键 `revalidation.html` → **Open with Live Server**；已有服务时刷新即可。

1. “轮次”默认最新，可选首轮或“全部轮次（分别标记）”；按“论文 / 方法 / 新候选”查看原文、上下文和PDF。
2. “旧11条备注·来源对照”只帮助溯源；“运行情况”保留全部失败、重试和失败partial原文，可看完整来源后返回代表路径候选。
3. “回看旧35条与原意见”返回原初筛页。新页只读，不填写新问卷或写入人审/产品批准，旧35条反馈不继承给新输出。

本次216请求全部结清，输入1,750,064、输出59,428；父轮99请求/13条候选，子轮117请求/11条候选。**11条含同组重复，并非11条去重有效描述**；子轮F失败尝试另1条AAH单列，不混入11。此前189次独立账本不改，历史合计405；本轮新上限300不包含旧189，剩余84不自动执行，实际账单未知。

CTR计算/测量定义已由用户确认仅作必要背景，一般视觉形态定义和直接尺寸/CT值仍允许。父轮3个方法各有1条将CTR计算定义列为主描述的记录，子轮为0；两轮context均0，未实证公式转存背景或全部语义正确。首轮多项修复不能单因素归因；父子轮设计只增一条公共system范围规则，未保存旧线上完整HTTP body，不能宣称所有实际payload仅此差异。

**子轮L05-B0汇总未完成**：33请求、505.98秒，615个已选块完成后，汇总15次响应触发应用端上下文估算上限。2条AAH主原文逐字相同，待核重复；诊断低估/小实性成分关联句仍待人核。子轮L05-F初次7＋重试18＝25请求、330.81秒，代表路径仅1条候选，失败另1条AAH保留。各方法仍为partial；parser partial、已选块处理和汇总完成分开，不称整体改善或全部成功。这些是该216批次结束时的工程问题，后续本地修复见下文。

[两轮实际报告](docs/acceptance/user-feedback-2026-11-05/revalidation/final-two-rounds/report.json)、[冻结阅读数据](docs/acceptance/user-feedback-2026-11-05/revalidation/final-two-rounds/reader-manifest.json) 和 [执行结清记录](docs/acceptance/user-feedback-2026-11-05/revalidation/final-two-rounds/execution-closure.json) 保留全部尝试。L01-R复用F非独立，显示代表F完整耗费；0新增调用不是零成本更优。新输出人核、专业医学核验及逐条产品批准均0，尚未选最优方案或通过完整S4质量/完整S5。

[新只读页真实浏览器证据](docs/acceptance/user-feedback-2026-11-05/revalidation/frontend/results.json)：14项Chromium、9项新单元和独立typecheck通过；159源/产物及两轮104源码快照核验保留，不能当医学通过率。旧197/37广测为付费前历史，本轮单项4/4和最终root tsc退出0另留证；未重跑广测。VSCode Live Server扩展及WebSocket刷新未实机验证。

[旧35条简单核验页](apps/pi-web/public/output-review/index.html) 与原JSON/问卷/ZIP/Excel保持；1名普通用户旧35条初筛（随机30＋风险5，11备注；UI32＋3）只绑定旧版本，仍可导入原JSON回看11条原意见。新页面不改写旧结果或自动批准新候选。

本轮后续本地可靠性修复已完成，见 [三项修复及回归报告](docs/acceptance/s4-reliability-2026-11-05/report.json)。核心实际通过221项抽取测试、37项评估测试和root TypeScript检查，新付费API调用0；这些结果不追改上面的216次真实输出，也不证明线上效果或医学质量。

- 工具严格拒绝无效参数，安全错误最多2次不同纠错机会，同一错误复投停止；不改写参数，未知工具、身份/路径越界等仍停止，纠错沿用当前计量。
- 同源特征修订保存为旧身份下的未审建议，精确建议重投幂等，不退化为新插入；不同主体/归属/锚点不因文字相似合并，人工版本保留。
- 汇总保留128原文行LRU传输工作集、完整句单元和显式补读，已读历史与当前可用内容分别记录；单次证据操作原子保存或回滚，独立拒绝诊断保留。合法保存但 `complete:false` 会披露阻塞与当前版本；原上下文及16响应上限未提高，仍可能不完整。

[新小规模复验方案（待明确批准）](docs/acceptance/s4-reliability-2026-11-05/proposal.json) 已离线准备，仅L05-B0/F，AGICTO Luna medium；共享最多64请求、150万输入token（含缓存）、16万输出token（含推理）及首次请求起30分钟，所有失败、纠错和重试同计。新授权文件未签、新执行未启动，旧窗口已届满，84请求余额不是新许可。`execution_job_ids` 只绑定此plan的可选执行范围，默认三方案保持；这批只验集成可靠性，不作单因素收益或三方案排名。旧reader、189/216账本及全部原结果保留，新输出人核/医学/产品批准0，S4质量及完整S5仍未过。

## 工作台启动

使用现有 Node 24.22.2 工具链。首次安装分别使用两份锁文件：

```bash
bash scripts/with-node.sh npm ci --ignore-scripts --cache .tools/npm-cache
bash scripts/with-node.sh npm ci --prefix apps/pi-web --workspaces=false --ignore-scripts --cache .tools/npm-cache
```

两个终端分别启动服务和前端：

```bash
bash scripts/with-node.sh npm run dev:server
bash scripts/with-node.sh npm run dev:web
```

浏览器访问 **http://127.0.0.1:5173**。后端仅监听 `127.0.0.1:3210`。 在云服务器运行时，这里的 `127.0.0.1` 是服务器本地地址；个人电脑需通过 SSH 本地端口转发或已有远程开发端口转发访问，再打开本机对应地址，本轮未实测转发链路。也可先停止开发前端，再执行生产构建与启动：

```bash
bash scripts/with-node.sh npm run build:web
bash scripts/with-node.sh npm run start:web
```

当前网页和只读服务不需要模型密钥，不会启动新的模型抽取。早先旧付费试验已经结束；历史预算和 `.env` 配置不构成新调用授权。历史授权与本次已结束的216实际调用分别留证；无额外新优化/付费。不要运行上游通用 `bin/pi-web.js`：T1 唯一受支持的网站入口是上述根脚本。

## 当前能做什么

- 查看已登记的五篇原 PDF、119 条既有候选原文以及原 Figure 来源目录。每次读取核验固定来源 SHA256、DocumentIR、Figure 目录和历史结果；历史候选重新通过现行原文交付校验。
- 每段按原文展示，保留页码、块 ID 与必要上下文；不使用 Markdown 格式化论文原文，不展示旧译文为原文。
- 默认查看历史 B0 结果；可切换已保留的 F/R 结果，旧 FR 仅作为历史记录。现行开发计划要求 B0/F/R 三方案对照，使用下述 CLI 准备；网页未启动新试验，相同输入复用结果不算独立测量。
- 有明确原文指向且整幅来源通过工程检查时，才显示该条配图和原图注。独立 Figure 目录分别标出明确对应、待核和无明确对应；目录中的流程图、示意图不自动成为肿瘤影像证据。
- 查看 SQLite 中已有 S1 工程任务的状态和业务事件，断线后按序号继续接收；工程 fixture 与真实论文候选分别标记。

论文上传、启动新的模型抽取、产品审核数据库和已审核导出按钮尚未接通，完整 S5 未完成。上述静态简单核验页仅在浏览器记录普通用户观察，不写产品审批。空结果不代表没有证据；工程核验不代表医学批准、全文召回或质量达标。现有 `evidence-delivery` 审核与导出核心逻辑继续保留，已审核导出仍须逐条确认。

完整人工参考答案不再是开发前置条件。旧“提前准备完整参考答案”页面、Vite 网站及专用打包命令已从活动应用移除，`/annotation` 不再可访问。本轮没有迁移任何真实用户草稿。旧离线包、旧网页专用 QA、全文答案指南/空模板/专家交接复制件及专用生成入口已物理清理，见 [逐文件处理清单](docs/acceptance/reference-preparation-cleanup-2026-11-04/disposition.csv) 与 [实际清理记录](docs/acceptance/reference-preparation-cleanup-2026-11-04/actual-deletions.json)。用户提供的 AI 原工作簿、7 份来源草稿和 S4 对照报告仍用于来源核对；共用开发 PDF、来源/医学目录、可选评测器及必要历史事实继续保留。[先前退役清单](docs/acceptance/pi-web-frontend-2026-11-04/annotation/retirement-manifest.json) 记录的是当时归档事实，所列 ZIP/TAR 现已删除。

## 边界与文件

`apps/pi-web/app/page.tsx` 是唯一正式工作台页面；`t1/` 提供 T1 专用视图和事件适配。原通用编码 API 已移出 Next 路由树；冗余停用副本已删除，完整原字节由固定上游压缩包保留，原路径与压缩包成员的对应关系见 [统一整理清单](docs/project-simplify-2026-11-04.json)；统一入口守卫只允许 T1 路由，终端、任意文件、凭证、模型管理及通用 Agent API 均不开放。

`apps/server/src/workbench.ts` 根据 `config/pi-web-workbench.json` 读取固定登记的开发成果，浏览器只传论文或资产 ID，不能传文件路径。该注册表是本轮只读阅览的数据来源边界，不是通用论文解析器的输入白名单。

`packages/agent/` 保留原文抽取、来源校验、保守配图、版本化候选和逐条人工确认的交付逻辑；`services/pdf-parser/` 保留正式 Docling CPU 与 MinerU 对照。`runtime-data/` 为本地运行数据；历史模型结果没有被本轮改写。

## 目录用途

| 目录或文件 | 用途与保留原因 |
| --- | --- |
| `apps/server/`、`apps/pi-web/` | 正式 Fastify 服务与唯一 Next 前端；保留当前上游开发结构、T1 适配和独立前端锁文件。 |
| `packages/`、`services/`、`config/`、`resources/` | 合约、Agent、PDF 解析、来源注册表及规则等运行与开发输入。 |
| `scripts/`、`tests/`、根配置与锁文件 | 当前安装、构建、运行、来源验证和测试入口；一次性写旧阶段状态的脚本已退役。 |
| `node_modules/`、`.venv/`、`.tools/` | 当前 Node 24、Python、Docling、MinerU 和 Playwright 开发依赖及模型；保持可用环境。 |
| `runtime-data/`、`evaluation/` | 本地 SQLite、历史模型结果与账本、来源快照、开发 PDF 和评测输入；保留原路径与指纹绑定。 |
| `../方案/子任务T1/` | 现行主开发计划、执行说明和对应机器可读规则；后续开发及验收以该目录的有效版本为准。 |
| 现行业务流程与工程决策 | 见 [T1 主开发计划](../方案/子任务T1/T1智能体开发计划.docx)、[开发执行说明](../方案/子任务T1/T1开发执行说明.docx) 与 `../方案/子任务T1/待讨论实现决策.csv`；2026-11-02旧图及生成prompt已归唯一历史ZIP。 |
| `docs/acceptance/` | 各阶段当时的工程证据；部分 PDF 解析成果、整幅 Figure、结果和来源清单仍被当前工作台直接读取，不能按历史目录整体删除。 |
| `third_party/pi-web/` | 固定完整 tar、完整来源 SHA 索引及三份精选原始基线；完整上游可在独立目录重建。 |
| `docs/project-history-2026-11-04.zip`、`docs/project-simplify-2026-11-04.json` | 一个必要历史归档和统一逐文件整理/恢复索引；中间候选、重复截图及可再生缓存不入档。 |
| `apps/pi-web/.next/`、`.tools/npm-cache/`、`__pycache__/` | 构建产物与可再生缓存；当前 `.next` 构建仍供 `start:web` 使用，本次保留；应用自有旧 Python 字节码已清理。 |

`docs/acceptance/*` 的报告、预算、来源 manifest 和名为 `current-handoff.json` 的文件均记录各自生成时的事实，不自动成为最新许可。旧阶段预算不能复用于新模型调用；新的模型抽取仍须按现行计划取得授权。本次整理没有调用付费模型，也没有改变尚未完成的完整 S5 或医学质量状态。被来源注册表与原文校验读取的文件继续保持原位置。

## 三方案比较与评测准备

当前入口为 `s4:compare`。[冻结比较计划](docs/acceptance/s0-s4-current-2026-11-04/three-method-proposal/plan.json) 的 L01/L05 B0/F/R 共6个逻辑条件、5份唯一输入，首轮在原规则下已完成：149请求、1,560,439输入token、87,410输出token，148条候选未获逐条产品批准，所有run仍为 `partial`。已选源块及汇总完成不代表原PDF完整处理或医学召回，见 [实际比较报告](docs/acceptance/s0-s4-current-2026-11-04/three-method-proposal/execution/report.json) 和 [逐条原文/配图自动核查页面](docs/acceptance/s0-s4-current-2026-11-04/three-method-proposal/automatic-audit-final/review.html)。L01-R复用F非独立，方法表引用F成本/耗时，账本只计一次真实唯一请求；0新增请求不能判零成本优势，最终赢家仍为null。

以下命令从 `code/` 执行。`prepare` 必须使用不存在的新目录；已有 `three-method-proposal` 不会被覆盖：

```bash
bash scripts/with-node.sh npm run s4:compare -- prepare --directory runtime-data/three-method-NEW
```

用户通过 [本批原授权](docs/acceptance/s0-s4-current-2026-11-04/three-method-proposal/authorization.json) 批准 AGICTO `gpt-6-luna medium`、L01/L05三方法及必要单点复验，累计上限300请求、600万输入token（含cache）、40万输出token（含reasoning）。原窗口届满后获批的11520秒 [时间续行](docs/acceptance/s0-s4-current-2026-11-04/summary-time-resume-authorization.json) 已用于完成余四组，共享原账本、start与额度，没有重跑首轮或L01-F。

首轮149请求＋五组汇总配对40请求＝189请求，3,198,316输入、122,639输出，全部结清，无missing usage，运行结束、锁已释放，已停止新增付费。唯一 [五组汇总对比报告](docs/acceptance/s0-s4-current-2026-11-04/summary-reread-comparison.html) 及 [机器可读JSON](docs/acceptance/s0-s4-current-2026-11-04/summary-reread-comparison.json) 同时列出有利与不利结果：before21请求/901514输入/18653输出/404.68秒，after19/736363/16576/369.68秒；L05-B0虽补读减少，输入193675→248713且请求4→5，不能泛化为各组更省或更快。

五组原文、上下文及Figure关联未变，部分疾病/序列/数值标签、待核状态、模型链接和自动未审语义状态确有差异；报告含原文定位及待核案例，不能说全部输出无变。仅两篇开发论文、每组一次、仅汇总阶段，真实账单未知；上述5组实验时正式prompt/默认三方法均未改；旧35条初筛仅旧版本；本次另已完成两轮真实运行，仍有summary不完整、重复和语义待核，专业医学核验0、最终赢家null。当前状态见 [顺序核查](docs/acceptance/s0-s4-current-2026-11-04/index.json)；[暂停记录](docs/acceptance/s0-s4-current-2026-11-04/user-pause-2026-11-05.json) 与清理/授权前零调用保留历史时点事实。首轮execute接口仍为 `npm run s4:compare -- execute --directory <已准备目录> --authorization <有效授权记录>`；本批已结束，旧ledger不构成新调用许可。

本轮用户已选择开发工作样本：5个实际job各随机6条共30条，另列5条实验风险，不混统计；L01-R复用不另加样。材料为 [真实输出人工核验包.zip](docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05/真实输出人工核验包.zip)，[manifest](docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05/manifest.json) 记录来源、版本、种子和机械校验。

原 `核验表.xlsx` 及ZIP作为既有证据和可选填写格式保留，当前主要操作入口改为上方简单核验页。若选择Excel，完整解压后先读“说明”，只填黄色栏，无法判断选“待核”，原文/出处不手改，另存 `核验表-已填写.xlsx`；原Excel的425个人工栏交付时全空。普通用户初筛及Excel填写都不自动变为产品已审核导出；正式样本量/阈值未冻结，专业与医学核验仍待落实。

后续另行生成未审核工作模板时，`--method`如实记录选样方法，配图可补`--figure-catalog path/to/catalog.json`。以下保留现有模板接口，生成材料不等于人工核验或冻结正式样本量：

```bash
bash scripts/with-node.sh npm run eval:prepare-sample -- \
  --document path/to/parser-result.json --result path/to/result.json \
  --count N --seed SEED --method "本次真实选样方法" \
  --output runtime-data/本次未审核工作样本.json
```

独立语料入口保留身份登记、封存和使用留痕；当前真实登记/封存/使用记录均为0，CLI完整流程仅在隔离 fixture 中测试。实际身份核对人填写 `--actor`，使用记录填写真实 `--evidence`；曾用于开发、选优或回归的文章族、DOI或PDF指纹不能充作独立验收资料，封存的独立资料不得参与开发对照：

```bash
bash scripts/with-node.sh npm run eval:independent-corpus -- inspect
bash scripts/with-node.sh npm run eval:independent-corpus -- register --metadata path/to/身份.json --pdf path/to/source.pdf
bash scripts/with-node.sh npm run eval:independent-corpus -- seal --source-id SOURCE_ID --actor "真实身份核对人"
bash scripts/with-node.sh npm run eval:independent-corpus -- expose --source-id SOURCE_ID --purpose independent_acceptance --actor "真实操作人" --evidence path/to/真实记录.json
```

旧固定实验、重试和续跑入口及 `s4:probe`、`s4:development` 已退役，原版恢复指向见统一整理清单；恢复历史源码不恢复其旧预算许可。S2旧Gold仅供可选历史评分，完整参考答案不是新前置。当前本地解析仍可能为 `partial`，S2/S3/S4医学质量与完整S5仍待验收；阶段实测范围见 [本轮S0–S4核查记录](docs/acceptance/s0-s4-current-2026-11-04/index.json)。

## 本地验证

```bash
bash scripts/with-node.sh npm run check
bash scripts/with-node.sh node_modules/.bin/tsx --test tests/integration/workbench.test.ts tests/integration/runtime.test.ts
```

`check` 同时检查后端与独立 Next 前端类型。浏览器回归需先完成 `build:web` 并运行 `start:web`，且端口 3210 为空；它创建并关闭自己的内存工程 fixture 服务，不调用外部模型：

```bash
bash scripts/with-node.sh node --import tsx scripts/verify-pi-web-browser.mjs
```

[本轮可读验收报告](docs/acceptance/pi-web-frontend-2026-11-04/index.html) 汇总真实日志、截图、上游原样/移动/修改清单及未验证范围。历史阶段的计数和结论仍查各自封存记录；本轮界面可用不改变医学质量状态。
