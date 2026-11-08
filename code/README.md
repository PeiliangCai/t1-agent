# T1 论文原文工作台

正式前端统一为 `apps/pi-web/` 的 Next.js 应用，以 [agegr/pi-web](https://github.com/agegr/pi-web/tree/f130910abf662b506b2ef2f475fc21a2fe57badc) 0.15.0 为基础。固定上游完整源码压缩包、1209 项文件指纹及三份常用基线（MIT 许可证、README、package.json）保存在 `third_party/pi-web/`；运行副本保留原标签页、整图预览、主题、导航菜单与面板调整组件。Fastify、SQLite/SSE 和 T1 受限 Pi SDK 1.4.0 保留，前端依赖独立安装。

所有命令从本目录 `code/` 执行；项目根目录的 `AGENTS.md` 继续适用。现行开发范围和执行顺序以根目录 [T1 主开发计划](../方案/子任务T1/T1智能体开发计划.docx) 与 [开发执行说明](../方案/子任务T1/T1开发执行说明.docx) 为准；工程证据在 `docs/acceptance/`。

用户已接受共同书目办法。当前3篇的解析工程检查通过，已知限制单列；本轮已发现的解析缺项均已修复，S2医学目录/OCR/S6不是该工程阻塞。Table1完整值/colspan及真正F正向检索已核对。已批准的一轮真实比较实际116请求、1,580,750 input、74,179 output、1472.808秒后因L07交付guard失败停止，未触128上限；L07-F未启动，剩12不再用。两项工程缺口已作局部离线修复、提取277/277及tsc0通过，修复未付费复测。原失败、账本和源snapshot保留，不定赢家。详见 [本轮报告](docs/acceptance/s0-s4-recheck-2026-11-08/report.json) 与 [文档/清理记录](docs/acceptance/s0-s4-recheck-2026-11-08/documentation-and-cleanup-report.json)。

新输出普通核验：在VSCode远端打开 [本轮核验页](docs/acceptance/s0-s4-recheck-2026-11-08/output-review/index.html)，右键 **Open with Live Server**。简单页14条/42点（前三实际run6条、L07固定种子6条及2拒绝风险）；[完整56条原文索引](docs/acceptance/s0-s4-recheck-2026-11-08/output-review/all-candidates.html) 另含42条未入简单抽查。已收到同目录真实意见并完整核对42个case/question身份及PDF/IR/记录/实际交付绑定：34看起来正确、3有问题、5无法判断；全部原文核对点看起来正确。全56中54机械可导出/2拒绝，L07组为48/2，这些分组及原输出不改写；普通意见不解除两项来源语境guard，也不构成医学准确率、业务逐条批准或L07原live成功。[反馈处理报告](docs/acceptance/output-feedback-2026-11-08/feedback-report.json)逐条记录语义相关性问题和待决范围。[原核验manifest](docs/acceptance/s0-s4-recheck-2026-11-08/output-review/manifest.json)中的15项Chromium检查仍属原交付时点；本轮未重跑整套浏览器或付费实验。

后续B0/F统一使用独立角色契约 `model-primary-assessment-1`，复用现有同一次summary。每个当前版本须给出 `primary_assessment` 四枚举之一：`context_only_suggested`、`visual_evidence_suggested`、`mixed_or_needs_context`、`uncertain`；缺失报 `summary_primary_assessment_required`，未覆盖或内容更新后的版本报 `primary_assessment_coverage_incomplete`，不能记汇总完成。它要求按整句/必要语境的陈述内容判断，数字阈值用于诊断风险、FOV/matrix用于成像配置时不能因出现特征词就成为独立目标；不按CTR、T4a、章节或数字全面排除，保留真实外观、形态定义、直接量值及必要否定条件。用户已进一步确认：有具体外观的完整诊断句保留必要判断/否定条件（如C07整句），单独纯诊断结论只作必要背景（C14）；纯正常解剖范围/距离定义仅在理解肿瘤病灶描述所需时作背景、不独立收录（C09），病灶直接尺寸仍允许。这两条分别版本化为 `visual-appearance-with-diagnostic-context-1` 与 `normal-anatomic-range-context-only-1`，不扩大成正常组织或对照图像的一概禁令。原普通意见和旧结果仍按原版本保留。

只有显式结构化的 `context_only_suggested` 进入可查看的“仅背景建议，未人工确认”组；旧任意字符串issue_codes不自动分类，旧无字段记录保持原样。新交付主候选在 `records` / `records.jsonl` / `records.csv`，背景建议在 `background_records` / `background-records.jsonl` / `background-records.csv`；来源与完整语境guard在分组前同样执行。抽样、审计及比较总数包含两组，并列主候选数与背景建议数；分组变化不能当准确率或性能提升。所有建议未医学批准，真实同版本业务审核可覆盖模型分组，模型对人工当前版本只追加proposal。新协议只作离线行为验证，未验证真实模型遵从或新增耗费，不能将新旧协议输出直接排名；旧 `visual-statements-2`、source-unit4、F预筛版本及冻结运行不追溯升级。

此前L05表3/表4、8处明确续段和L07图2/3/6裁边已修复并对照原页，43点普通布局意见已绑定。旧审核包/冻结IR保留其版本，不冒充本轮新生产解析或医学批准。

## 旧布局核验包回看

1. 在VSCode远端打开 `apps/pi-web/public/input-review/index.html`，右键 **Open with Live Server**。无需启动Next/Fastify，也无需模型密钥。
2. 左侧选案例，右侧默认“修后”，可切“修前”，点图放大，并对照原页PNG或同SHA的PDF物理页。表格可以上下、左右滚动；点 **展开全表** 可查看下半部分，再点“收起”恢复。
3. 每个核验点选 **看起来正确 / 有问题 / 无法判断**，并备注问题位置。未查看或无法判断均不当通过。
4. 点 **导出审核意见**，下载 `PDF解析核验意见-日期时间.json`；可手动放回 `apps/pi-web/public/input-review/` 并在对话告知，或直接说明案例与问题位置。页面不会上传或静默写入服务器。

意见只暂存在当前浏览器的当前地址、端口。换地址、端口或浏览器前请先导出，之后用 **导入审核意见** 恢复同一资料版本；不同资料版本不会自动套用。

当前包为3篇原PDF、15张原页PNG、20案例/43核验点（7整图、3表、10续段）。已收到同目录用户JSON：43点均为looks_correct、无备注，其中4点属于书目；pack、每个case/question、PDF/IR及artifact完整绑定均已通过。这些是普通布局意见，不是医学准确率或产品逐条批准。Nov7交付时反馈0保留在旧报告，旧审核包与用户JSON保持原字节。

参考文献不属于T1视觉特征抽取目标；保留原PDF、raw文本及页码/定位，解析后仅将边界明确的书目从模型输入与提取资格排除，无法明确识别时保守保留。B0/F共用该范围规则，不物理裁页，不以两处书目续接未自动合并阻断当前抽取范围。 两处书目候选源IR仍未自动合并；本次实现与验证见 [反馈与书目范围报告](docs/acceptance/bibliography-scope-2026-11-08/feedback-and-scope-report.json)，已完成离线验证。L01/L05/L07分别排除73/92/280个原始文本块，属于输入范围变化，不能当文献条目数量、速度、费用或医学收益。未识别、不完整或边界歧义的书目仍保留；仅同篇来源身份和归属均有效、只读且唯一问题为已确认书目范围的查询，按既有协议最多2次不同参数纠正；整次拒绝查询不返回原文、不记为已读、不自动改参数。重复、次数或预算耗尽、未知ID、他文、身份覆盖及候选更新等错误仍停止并保留partial。此前书目范围环节的262/262提取回归、只读纠正28/28及TypeScript检查保留于该轮报告；那一轮0模型/付费/新解析或页重渲染，不用于描述本轮生产重解析。

[表格与续段工程报告](docs/acceptance/pdf-structure-review-2026-11-07/table-continuation-report.json)、[整图与页面报告](docs/acceptance/pdf-structure-review-2026-11-07/figure-review-report.json) 及 [实际核验清单](docs/acceptance/pdf-structure-review-2026-11-07/review-checklist.json) 分别留证。最终45项Python、21项解析TS、249项抽取（含5项实际工具）及tsc0通过；11项实际HTTP/Chromium检查验证页面及表4最后一行、展开/收起等功能，自动化截图标记不是用户审核。VSCode Live Server扩展本身未实机验证。

本页未纳入L02和L05统计图2/3缺region案例，不将这些记为已修或已核。图6是含MRI说明脚注的示意表，几何正确不自动批准为医学扫描证据。上轮仅隔离错误、有限下游工程及原预算记录按各自时点保留，当前以最终unit4和已绑定的审核包为准。

此前已交付的真实输出为已关闭的41次批次；本轮116次及离线恢复见上方新报告：[只读页](apps/pi-web/public/output-review/reliability.html)、[真实报告](docs/acceptance/s4-reliability-2026-11-05/live-revalidation/report.json) 与 [版本来源数据](docs/acceptance/s4-reliability-2026-11-05/live-revalidation/reader-manifest.json)。B0六候选汇总被特征名来源校验拒绝，F两候选汇总完成；两run均 `partial`，共8身份/11版本/1建议，新人核及医学/产品批准0。B0六条主句均在F选中、派发和已读清单，不能简单归因为F删去主句；[原因分析](docs/acceptance/s4-reliability-2026-11-05/live-revalidation/evidence-interpretation.json) 与 [源块核对](docs/acceptance/s4-reliability-2026-11-05/live-revalidation/analysis-addendum.json) 区分事实和假设。PDF已有局部结构问题，其为抽取不佳主因尚未证明。

旧批次按原版本保留：[216次两轮只读页](apps/pi-web/public/output-review/revalidation.html)、[两轮报告](docs/acceptance/user-feedback-2026-11-05/revalidation/final-two-rounds/report.json)、[189次首轮/汇总历史](docs/acceptance/s0-s4-current-2026-11-04/summary-reread-comparison.json)。原用户“我同意你执行”“批准”及189批次仅续原剩余时窗的确认、原额度/账本/失败均可沿报告追溯；各批次已结束，旧余额不构成新许可。旧三方法记录不追认为当前B0/F结论，当前没有赢家，S4质量和完整S5未过。

[旧35条普通用户初筛](apps/pi-web/public/output-review/index.html) 与原JSON/问卷/ZIP/Excel保留，11备注仅绑定旧版本，不继承给新输出。Nov5的工具有限纠错、同身份修订/幂等和汇总工作集/原子提交修复见 [工程报告](docs/acceptance/s4-reliability-2026-11-05/report.json)；221/37/tsc0只描述当时离线验证，不当真实模型改善。

只读回看：VSCode远程打开 `apps/pi-web/public/output-review/`，右键 `reliability.html` → **Open with Live Server**。可查看两组状态、各版本原文/PDF/整图及失败，并返回旧216和35入口；不调用API、不写人审或storage。最新静态页 [10项实际Chromium检查](docs/acceptance/s4-reliability-2026-11-05/live-revalidation/frontend/results.json) 已留证；VSCode扩展本身未实机验证。新页面不等于完整S5。

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

当前网页和只读服务不需要模型密钥，不会启动新的模型抽取。早先旧付费试验已经结束；历史预算和 `.env` 配置不构成新调用授权。旧189/216/41历史授权和调用均已关闭；本轮新比较另获用户真实批准后已因交付guard失败停止；只读网站不会自行启动额外调用。不要运行上游通用 `bin/pi-web.js`：T1 唯一受支持的网站入口是上述根脚本。

## 当前能做什么

- 查看已登记的五篇原 PDF、119 条既有候选原文以及原 Figure 来源目录。每次读取核验固定来源 SHA256、DocumentIR、Figure 目录和历史结果；历史候选重新通过现行原文交付校验。
- 每段按原文展示，保留页码、块 ID 与必要上下文；不使用 Markdown 格式化论文原文，不展示旧译文为原文。
- 默认查看历史 B0 结果；已保留的 F/R/FR 仅按对应历史版本回看。现行开发只比较B0/F，R/FR不再执行；网页没有启动新试验，相同输入复用不算独立测量。
- 有明确原文指向且整幅来源通过工程检查时，才显示该条配图和原图注。独立 Figure 目录分别标出明确对应、待核和无明确对应；目录中的流程图、示意图不自动成为肿瘤影像证据。
- 查看 SQLite 中已有 S1 工程任务的状态和业务事件，断线后按序号继续接收；工程 fixture 与真实论文候选分别标记。

论文上传、启动新的模型抽取、产品审核数据库和已审核导出按钮尚未接通，完整 S5 未完成。上述静态简单核验页仅在浏览器记录普通用户观察，不写产品审批。空结果不代表没有证据；工程核验不代表医学批准、全文召回或质量达标。现有 `evidence-delivery` 审核与导出核心逻辑继续保留，已审核导出仍须逐条确认。

完整人工参考答案不再是开发前置条件。旧“提前准备完整参考答案”页面、Vite 网站及专用打包命令已从活动应用移除，`/annotation` 不再可访问。本轮没有迁移任何真实用户草稿。旧离线包、旧网页专用 QA、全文答案指南/空模板/专家交接复制件及专用生成入口已物理清理，见 [逐文件处理清单](docs/acceptance/reference-preparation-cleanup-2026-11-04/disposition.csv) 与 [实际清理记录](docs/acceptance/reference-preparation-cleanup-2026-11-04/actual-deletions.json)。用户提供的 AI 原工作簿、7 份来源草稿和 S4 对照报告仍用于来源核对；共用开发 PDF、来源/医学目录、可选评测器及必要历史事实继续保留。[先前退役清单](docs/acceptance/pi-web-frontend-2026-11-04/annotation/retirement-manifest.json) 记录的是当时归档事实，所列 ZIP/TAR 现已删除。

## 边界与文件

`apps/pi-web/app/page.tsx` 是唯一正式工作台页面；`t1/` 提供 T1 专用视图和事件适配。原通用编码 API 已移出 Next 路由树；冗余停用副本已删除，完整原字节由固定上游压缩包保留，原路径与压缩包成员的对应关系见 [统一整理清单](docs/project-simplify-2026-11-04.json)；统一入口守卫只允许 T1 路由，终端、任意文件、凭证、模型管理及通用 Agent API 均不开放。

`apps/server/src/workbench.ts` 根据 `config/pi-web-workbench.json` 读取固定登记的开发成果，浏览器只传论文或资产 ID，不能传文件路径。该注册表是本轮只读阅览的数据来源边界，不是通用论文解析器的输入白名单。

`packages/agent/` 保留原文抽取、来源校验、保守配图、版本化候选和逐条人工确认的交付逻辑；`services/pdf-parser/` 保留正式 Docling CPU 与 MinerU 对照；本轮指定表格/续段/裁边修复和对照页见上方报告；页解码、案例与离线绿灯不代表结构或全篇内容保真。`runtime-data/` 为本地运行数据；历史模型结果没有被本轮改写。

## 目录用途

| 目录或文件 | 用途与保留原因 |
| --- | --- |
| `apps/server/`、`apps/pi-web/` | 正式 Fastify 服务与唯一 Next 前端；保留当前上游开发结构、T1 适配和独立前端锁文件。 |
| `packages/`、`services/`、`config/`、`resources/` | 合约、Agent、PDF 解析、来源注册表及规则等运行与开发输入。 |
| `scripts/`、`tests/`、根配置与锁文件 | 当前安装、构建、运行、来源验证和测试入口；旧阶段写入入口已退出当前命令链。少量唯一历史材料生成配方保留用于复现，当前用途核验见本轮文档/清理报告。 |
| `node_modules/`、`.venv/`、`.tools/` | 当前 Node 24、Python、Docling、MinerU 和 Playwright 开发依赖及模型；保持可用环境。 |
| `runtime-data/`、`evaluation/` | 本地 SQLite、历史模型结果与账本、来源快照、开发 PDF 和评测输入；保留原路径与指纹绑定。 |
| `../方案/子任务T1/` | 现行主开发计划、执行说明和对应机器可读规则；后续开发及验收以该目录的有效版本为准。 |
| 现行业务流程与工程决策 | 见 [T1 主开发计划](../方案/子任务T1/T1智能体开发计划.docx)、[开发执行说明](../方案/子任务T1/T1开发执行说明.docx) 与 `../方案/子任务T1/待讨论实现决策.csv`；2026-11-02旧图及生成prompt已归唯一历史ZIP。 |
| `docs/acceptance/` | 各阶段当时的工程证据；部分 PDF 解析成果、整幅 Figure、结果和来源清单仍被当前工作台直接读取，不能按历史目录整体删除。 |
| `third_party/pi-web/` | 固定完整 tar、完整来源 SHA 索引及三份精选原始基线；完整上游可在独立目录重建。 |
| `docs/project-history-2026-11-04.zip`、`docs/project-simplify-2026-11-04.json` | 一个必要历史归档和统一逐文件整理/恢复索引；中间候选、重复截图及可再生缓存不入档。 |
| `apps/pi-web/.next/`、`.tools/npm-cache/`、`__pycache__/` | 构建产物与可再生缓存；当前 `.next` 构建仍供 `start:web` 使用，本次保留；应用自有旧 Python 字节码已清理。 |

`docs/acceptance/*` 的报告、预算、来源 manifest 和名为 `current-handoff.json` 的文件均记录各自生成时的事实，不自动成为最新许可。旧阶段预算不能复用于新模型调用；新的模型抽取仍须按现行计划取得授权。文档与清理操作本身不发起模型调用；本轮已结束的116次真实比较独立记账，完整 S5 或医学质量状态仍未通过。被来源注册表与原文校验读取的文件继续保持原位置。

## B0/F比较与评测准备

当前入口仍为 `s4:compare`，默认配置为 `config/two-method-comparison.json`，支持B0/F离线准备及已授权计划的执行。本轮新授权与b634daf4...执行计划已绑定，该轮116次后已停止；旧三方法plan/authorization及旧余额仅历史，不能复用。CLI实际离线验证和开发入口清理见 [两方法转换报告](docs/acceptance/pdf-input-quality-2026-11-07/two-method-transition.json)。上轮有限后续离线修复按历史保留；具体PDF修复和对照页已交付，普通布局意见已完整绑定，B0/F共同书目范围排除已离线验证；此次真实比较使用修复后同源输入，现仅做离线audit和输出抽查；未完成配对不推赢家。旧掩码和旧实验不能证明新输入等价或性能收益。prepare本身不产生许可；本轮授权独立来自用户实际批准，不能据离线或候选数量宣称医学质量/赢家。

以下命令从 `code/` 执行，`prepare` 使用不存在的新目录：

```bash
bash scripts/with-node.sh npm run s4:compare -- prepare --directory runtime-data/two-method-NEW
```

新比较须共享同一源PDF/IR及公共规则版本、论文/范围、模型/推理设置、公共提示/工具/校验、输出/配图规则和计量条件；是否正向预筛及相应选块差异正是方法变量。每个优化点单独记录前后、固定项和保留/回退；工程集成修复不宣称单因素收益。必要时按版式和目标描述密度补少量开发论文，不恢复完整标准答案任务，开发/回归与独立验收用途隔离，不自动扩大实验或付费。

旧L01 F/R输入完全相同、L05只差一块140码点，且只涉及肺癌CT，不能支持广泛排名。旧报告和失败版本保持原样，不由候选数或旧35条反馈推断新结果准确率、召回或赢家。

历史已交付的开发工作样本：5个实际job各随机6条共30条，另列5条实验风险，不混统计；L01-R复用不另加样。材料为 [真实输出人工核验包.zip](docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05/真实输出人工核验包.zip)，[manifest](docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05/manifest.json) 记录来源、版本、种子和机械校验。

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

旧固定实验、重试和续跑入口及 `s4:probe`、`s4:development` 已退役，原版恢复指向见统一整理清单；恢复历史源码不恢复其旧预算许可。S2旧Gold仅供可选历史评分，完整参考答案不是新前置。当前本地解析仍可能为 `partial`，S2/S3/S4医学质量与完整S5仍待验收；阶段实测范围见 [本轮S0–S4核查记录](docs/acceptance/s0-s4-recheck-2026-11-08/report.json)，Nov4阶段索引仅保留历史事实。

## 本地验证

```bash
bash scripts/with-node.sh npm run check
bash scripts/with-node.sh node_modules/.bin/tsx --test tests/integration/workbench.test.ts tests/integration/runtime.test.ts
```

`check` 同时检查后端与独立 Next 前端类型。浏览器回归需先完成 `build:web` 并运行 `start:web`，且端口 3210 为空；它创建并关闭自己的内存工程 fixture 服务，不调用外部模型：

```bash
bash scripts/with-node.sh node --import tsx scripts/verify-pi-web-browser.mjs
```

[旧前端可读验收报告](docs/acceptance/pi-web-frontend-2026-11-04/index.html) 汇总当时真实日志、截图、上游原样/移动/修改清单及未验证范围。历史阶段的计数和结论仍查各自封存记录；本轮界面可用不改变医学质量状态。
