# T1 论文证据提取：S4工程进行中，医学质量待验收

2026-11-03用户已确认 **完整Docling 2.145.0 CPU + docling-parse 7.24.2原文锚点为正式主用**，MinerU4.1.4 basic ONNX保留对照。组件选定不等于S3或医学质量通过；当前[正式选型与使用入口](docs/acceptance/s3/parser-selection-2026-11-03/index.html)及[配置](config/pdf-parser.json)已生效，S2/S3质量待办与原门槛保留；S4于2026-11-03按用户继续指令开工，S5未启动。

S0/S1 工程验收及用户人工审核已通过，原正式审查 3/3 轮封存。用户自述不理解底层配置，基于交付说明和工程检查同意推进；这不代表逐项技术验证、独立审计或医学验收。当前已交付 S2 评测准备包，S2 正式审查 2/3 轮，阶段仍为 `in_progress`。用户已授权仅调整开工顺序，S3 进入 `engineering_in_progress`、`stage_passed=false`，正式审查 3/3（本轮工程原型）；原阶段 gate 与质量依赖保留。S4 已按满足的技术依赖开工，正式审查2/3；S5未启动。人工全文标注和医学复核人员暂未安排，相关工作保持待办。详见 [S0/S1 审核及 S2 交接](docs/acceptance/s2/s0-s1-human-approval-and-s2-handoff.json) 与 [S2 准备包交付](docs/acceptance/s2/preparation-delivery.json)。

本次人工抽取前端与离线包工程交付已完成主会话最终正式审查，沿用上述历史2/3，**S2累计3/3**，详见 [本次审查记录](docs/acceptance/s2/annotation-ui/final-review.json)。该判断仅涉及本次工程交付；S2仍为 `in_progress`、`stage_passed=false`，人工参考答案与医学复核继续待办，既有历史报告保留。

HTTP/前端原型继续验证 Pi 与受限业务工具往返、范围契约和状态回传；S3 已把完整 Docling CPU 与 MinerU basic ONNX CPU 接入版本化 DocumentIR 和真实 Pi 受限读取工具链，HTTP上传/医学抽取产品流程仍归后续阶段。工程样例不能作为论文证据；S2 新增的是资料、模板和确定性计分工具。原 [S1 验收记录](docs/acceptance/s1/acceptance.json) 及真实调用版本边界保持封存。

项目根目录的 `方案/` 保存用户维护的现行计划，`research/` 保存调研资料。**所有应用命令均从 `t1-agent/code/` 执行**，根目录的 `AGENTS.md` 继续适用。

## S2 人工参考答案工作台（本次新增）

医学填写者使用 [离线网页包](dist/T1-S2-离线标注工作台.zip)：完整解压后，用较新的 Chrome 或 Edge 双击打开 `离线标注工作台.html`，无需安装开发工具、启动服务器或联网。5篇原PDF已经内嵌，原件副本在包内 `论文PDF/`；这些是可选的既有开发资料，实际填写范围由联系人安排。L07与MED04同族，仅列一次；L02第3物理页需按具体区域核对本篇与另一篇续文的边界。

左侧阅读全文、翻页和缩放，可选中文字复制；右侧从空白开始记录各个原文片段和必要语境，各片段分别保留物理页、印刷页与位置。医学属性、收录争议、逐页核对和本篇信息分组填写。记录的 `R-` 编号在删除其他条目后保持稳定，可用于填写关联；不要用临时显示顺序作永久引用。

当前输入自动尝试保存到**当前浏览器**，没有服务器同步。请固定使用同一浏览器配置与网页文件路径；移动文件、清除浏览记录或使用隐私模式可能导致无法恢复。每次结束前点击“下载完整备份”，保留JSON文件；“导入备份”经结构、页码与来源身份校验后恢复指定论文，替换前会确认。恢复旧存档失败时自动保存暂停，原存档保留并可下载；存储空间不足或被禁用时，当前页面仍可下载备份。

“导出回收表”提供便于表格查看的CSV，完整可恢复记录以JSON为准。CSV已处理以公式符号开头的填写内容。“打印本篇”或下方勾选工作论文后先显示完整只读预览，再点击“打印 / 保存为PDF”，选择A4。原文、必要语境、医学属性、逐页记录、争议和签名栏全部进入打印排版；草稿也可打印。浏览器直接打印会切换到本篇完整排版。打印稿用于阅读，修改与继续填写请保留JSON备份。

未知不表示阴性，空白草稿不表示零证据。逐页核对需主动记录，翻页不会自动完成；“声明本篇填写完成”只记录填写者的声明，后续修改会撤回。医学复核始终独立待办，本界面不生成真实批准事件、不改变S2验收或金标完成状态。JSON采用独立的 `t1-human-workbench-backup-1` 草稿格式，需另行映射到现有计分契约，不能直接投入评测。

开发与复现仍使用现有应用入口；以下命令只运行本地工作，不调用真实模型API：

```bash
bash scripts/with-node.sh npm run dev:web
bash scripts/with-node.sh npm run test:annotation
bash scripts/with-node.sh npm run build:web
bash scripts/with-node.sh node scripts/package-annotation-offline.mjs
```

`dev:web` / `build:web` 会先校验SHA并仅复制已授权的5份原PDF到 `apps/web/public/papers/`；普通静态构建在 `apps/web/dist/`。离线打包复用同一 `src/main.tsx` 与全部表单逻辑，将PDF、PDF.js worker及所需资源嵌入单HTML。工程检查与浏览器证据位于 [annotation-ui](docs/acceptance/s2/annotation-ui/)，本次新增入口不改写既有各阶段结论。

## 安装与配置

需要 Linux x86_64、Python 3、HTTPS 网络。Node 固定为 24.22.2，安装脚本从 Node 官方站下载并核对 SHA256，只写入本目录 `.tools/`；不修改系统 Node 配置。

```bash
python3 scripts/install-node.py
bash scripts/with-node.sh npm ci --no-audit
python3 scripts/create-env.py
```

`create-env.py` 仅在 `.env` 不存在时以 0600 权限创建；已有配置不覆盖。编辑 **`code/.env`** 中以下变量，密钥仅写入 `T1_MODEL_API_KEY` 右侧。进程环境中同名变量优先于文件；通过 dotenv 解析，不执行 shell。

```dotenv
T1_MODEL_PROVIDER=agicto
T1_MODEL_BASE_URL=https://api.agicto.cn/v1/
T1_MODEL_ID=gpt-4.1-mini
T1_MODEL_API_KEY=
```

AGICTO 的地址与模型仅用于本阶段接口验证，依据其 [OpenAI 兼容文档](https://docs.agicto.com/guides/openai-compatible) 和 [模型页](https://agicto.com/model)；正式医学抽取模型在 S4 对照后共同确定。密钥、`.tools/`、依赖、运行数据和构建产物均已列入 `.gitignore`，不得将真实密钥写入示例或报告。

## 检查与演示

以下命令只运行本地检查；普通测试不调用真实模型。

```bash
python3 scripts/check-s3.py
```

当前入口依次运行解析契约导出、类型检查、Python 构造 PDF 测试、TS 解析桥接测试、既有单元/集成/评价回归及前端构建；Node 命令通过 `bash scripts/with-node.sh` 使用本地工具链。新日志只写 `docs/acceptance/s3/checks/`，不覆盖旧报告。`check-s2.py` 和 `run-local-checks.py` 为旧阶段入口，本轮未调用；计分器的真实空模板仍返回预期的“未可评估”。

以下命令单独进行真实模型验证，会产生 API 用量。仅发送明确标记的工程文本，不读取或上传原 PDF。

```bash
bash scripts/with-node.sh npm run smoke:pi
```

CLI 通过 Pi 获取当前任务上下文、读取限定块、查询工程词表、提交原文候选。程序定位 Unicode 码点区间并保存候选后发送业务事件；候选初始为 `pending`，工程样例禁止导出为论文证据。Pi 只激活五个业务工具；不发现工作区指令、Skill、扩展、主题或提示模板，不暴露 shell 或任意文件/网络工具。凭证与 Pi 会话保留在内存。

每次真实演示在 `docs/acceptance/s1/` 保存独立报告，`smoke-pi-latest.json` 指向最近一次结果。报告区分模型响应次数、token、工具事件、业务状态及工程标记。网关实际计费未知时记录 `null`，不把 SDK 内部价格占位值当作实际费用。S1 演示关闭自动重试和缓存预热，最多八次模型响应，并设置整体超时；失败记录保留。

本轮真实样例获得 4 次模型响应、5202 tokens。真实报告对应第 2 轮审查修复前的成功路径；之后的初始化失败终态清理与跨 SQLite 连接 SSE 通知修复，由 15 项单元、8 项集成离线回归验证，未重新调用付费 API。版本边界及 SHA 见 `docs/acceptance/s1/post-review-fixes.json`。

```bash
bash scripts/with-node.sh npm run dev:server
bash scripts/with-node.sh npm run dev:web
```

服务端调试入口为 `http://127.0.0.1:3210`；Vite 也仅监听回环地址。远程查看可使用本人 SSH 端口转发，本轮未实际验证隧道或开放公网访问。后端提供健康检查、工程词表及已保存样例运行的只读快照/候选/SSE；不提供真实论文上传、审核或产品抽取接口。前端仅为 React/PDF.js 骨架。

## 契约与数据

- `packages/contracts/`：Scope、FeatureBinding、RunInput、DocumentIR、28 字段 CandidateRecord 及业务事件 Schema；导出的 JSON 位于 `schema/`。
- `evaluation/fixtures/engineering-example.json`：可核对的工程文本、范围、DocumentIR 和词表；没有真实 PDF 页码。
- `packages/agent/`：Pi 适配、任务绑定工具、工程候选校验和最小 SQLite 账本。
- `services/pdf-parser/adapter.py`：本地原文字行/几何后端；`structured.py` / `structured-cli.py`：两候选完整CPU结构、来源映射及CLI；显式历史S1 stub另行保留。
- `runtime-data/t1.sqlite`：本机 SQLite WAL 数据库；`runtime-data/runs/` 为专用运行目录。数据库事务不跨模型等待，候选与必要事件保存成功后才通知。该目录须持久化保留，当前仅验证本地关闭/重开，Docker 数据卷和部署恢复归 S5/S7。

三层初始范围均为 `all`；`selected` 必须有合法选择。上游改选保留有效项、标出失效项，由用户处理后才能开始；系统不自动扩大范围。特征通过显式 binding 保留适用关系，不机械组合癌种与图像类型。未知医学信息保持未知，用户选择不能冒充论文事实。

## 验收证据与边界

[S0 记录](docs/acceptance/s0/acceptance.json) 包含支持矩阵、已确认决策及后续事项、服务器环境和官方 Node 安装溯源。[S1 索引](docs/acceptance/s1/review-index.json) 指向测试、真实工具调用、SDK 源码核验和审查 diff。Word 仅增量追加记录，保留原 XML/段落的证明见各阶段 `*preservation.json`；未运行归档生成器。

首版计划支持中英文文本型 PDF、逐条人工审核及方案 B 逐篇导出；S3原页定位与S4候选抽取已有工程实现，逐条人工审核及正式导出尚待后续，医学质量仍未验收。真实 PDF 定位归 S3，医学抽取与正式模型归 S4，完整审核/导出及多任务负载归 S5/S6，Docker 交付归 S7。扫描/OCR、批量提交、跨论文检索和断点续跑为后续扩展。S2 当前完成准备包，完整人标、医学复核、最终分组与独立验收封存、规则批准尚未完成；没有冻结数值门槛或正式样本规模，S2 未通过。

## S2 资料与计分入口

[来源清单](evaluation/manifests/source-register.json) 与 [CSV](evaluation/manifests/source-register.csv) 包含 9 篇历史负载样本及 MED01—MED05，共 14 条记录、13 个已知身份族；MED04 与 L07 同 DOI 同族。现有来源已用于调研，仅为参考或开发候选，[论文族分组草稿](evaluation/manifests/family-split-draft.json) 尚未封存。5 份定向获取的 PDF 在 `evaluation/corpus/development-candidates/`，本次文件 SHA 和字节见 [获取记录](docs/acceptance/s2/downloads.json)；S2 登记快照中的本地页数组成未知字段保持 `null`；S3候选实测另行记录实际物理页数和文字层；正式Docling主用选择已由用户确认，见当前选型入口。

[35 项筛选表](evaluation/catalog/feature-screening-draft.csv) 保留原 ID、来源线索和理由，医学分类、同义、上下位及适用关系均待复核，不进入产品默认词表。标注请先读 [Word 指南](evaluation/annotations/T1-S2人工标注指南_待确认_v0.2.docx)，再使用 [全文标注模板](evaluation/annotations/templates/full-text-annotation-template.json)、[证据填写表](evaluation/annotations/templates/evidence-units-template.csv) 及同目录下的跨页证据、逐页检查和争议模板。模板没有真实金标或审核人员；[待确认口径](evaluation/rules/pending-confirmations.json) 留待人工作业开展时讨论。

```bash
bash scripts/with-node.sh npm run test:evaluation
bash scripts/with-node.sh npm run eval:quality -- --input evaluation/fixtures/scoring/synthetic-example.json --output evaluation/reports/fixtures/自选唯一报告名.json
bash scripts/with-node.sh npm run eval:quality -- --input evaluation/annotations/templates/unevaluable-real-input.json --output evaluation/reports/real/自选唯一报告名.json
```

评价器仅对人工裁定的匹配边作最大基数一对一匹配，重复及范围外预测计 FP，失败论文的应有金标保留 FN；跨页/块片段属于同一证据单元。零分母返回 `null`，缺完整人标或裁定的真实输入返回 `not_evaluable`。合成测试与真实报告分目录，已有报告不覆盖；计分器不判断医学语义、不调用模型，S2 准备包不产出正式质量通过结论。


## S3 工程先行边界

[用户授权与工程/验收依赖](docs/acceptance/s3/engineering-start-authorization.json) 保留原话及修改前备份。S2 人工作业并行待办，工程启动不表示S2或S3通过；后续正式组件选择独立记录，不能替代质量验收；定义/观察/转引的基本收录方向沿用现行执行说明，待确认的是具体拆分、类型判别及计分细则。旧 S0/S1/S2 验收和版本清单封存，新日志只写 `docs/acceptance/s3/`。


## S3 本地解析与定位

工程入口采用 `docling-parse==7.24.2`，它是 Docling 的无模型 PDF 文字/几何后端。这个适配路径保留后端文字行顺序与原始坐标，不重建表格或判定图注。可替换的 Python `ParserAdapter` 和 TS `LocalPythonParserAdapter` 使用同一输入身份；v2路径保持兼容，新增v3 `LocalStructuredPythonParserAdapter` 已接入真实Pi受限读取，HTTP上传入口尚未接通。`/health` 明确报告本地 CLI 已实现、HTTP 尚未接通；`UnimplementedParser`/`UnimplementedParserAdapter` 只为显式选择历史 S1 stub 的调用保留。

```bash
python3 scripts/install-s3-parser.py
bash scripts/with-node.sh npm run parser:contracts
.venv/bin/python services/pdf-parser/cli.py parse --run-id my-s3-run --document-id L01 --file-reference evaluation/corpus/development-candidates/L01.pdf --file-sha256 8f5e38ac6575cd776469506fece887e85acb95bf4df0d61ae489cc88cf0de267 --output runtime-data/pdf-parser/my-s3-run/L01.json
```

安装通过现有 pip 的 `--python` 只写 `.venv`，包缓存只写 `.tools/pdf-parser`；主机缺少 ensurepip 时不安装系统软件。`requirements-text.lock.txt` 保存纯文字后端环境，`requirements-cpu-standard.lock.txt` 保存可选完整 CPU 探测环境。原 PDF 不改写，不自动提交给远端服务，不调用 LLM。输出文件采用独占创建；重跑请选择新路径。

CLI 退出码 `0` 只表示所声明文字层解析成功，`2` 表示部分覆盖或不支持，`1` 表示结构化错误。带图像的页面会保留“图中文字未核”的状态；无文字层、扫描、空白/矢量页及坏页逐页列出，不冒充全文完整覆盖。bitmap 数只代表识别出的位图对象，不能证明不存在矢量图或图中烧录文字。`parsed/ok`、所有页面已枚举和所有已输出块已处理，都不表示人工忠实度、医学召回、表格关联或阅读顺序通过。

[DocumentIR v2 契约](packages/contracts/schema/DocumentIRV2.json) 固定 Unicode 码点与 `[start,end)` 区间；`raw_text` 是后端解码的原文，不是 PDF 内容流字节。项目只规范 CRLF/CR，保留 `raw_text`、后端 `text`、规范化映射及原件 SHA。版本绑定原件、文档身份、适配代码哈希、后端及配置，改版不复用旧引用。旧 S1 `DocumentIR v1` 和 fixture 保持兼容；真实论文均为 `fixture=false`。

坐标统一为**应用页面旋转后的 CropBox 左上角、单位 pt**，`/UserUnit` 已应用。原生后端为已旋转裁剪页的左下角 PDF 用户单位，保留其多边形、原 PDF MediaBox/CropBox、原旋转与反变换矩阵；`canonical_to_pdf` 可恢复原 PDF 用户坐标供 PDF.js 后续使用。定位粒度为整个文字行框，不能伪称精确字形高亮。跨块/跨页引用显式列出 `segments` 及拼接符，逐段核对块 ID、文档及文本版本，不依赖全文首个字符串命中。`quote`/`raw_quote` 是按显式 `joiner` 形成的展示组合，不能当作连续原文；权威引文是逐段源文及 `segments` 边界，后续抽取与提交必须保留边界。该S3入口未接入候选提交；S4已通过独立真实抽取接口保存候选，见下文。

```bash
.venv/bin/python scripts/run-s3-development.py
.venv/bin/python services/pdf-parser/cli.py locate --document docs/acceptance/s3/runs/2026-11-02T14-41-35-628654Z/L01.result.json --reference docs/acceptance/s3/runs/2026-11-02T14-41-35-628654Z/L01.reference.json
```

[五份真实开发样本实测](docs/acceptance/s3/runs/2026-11-02T14-41-35-628654Z/summary.json) 共 41 个物理页、3887 个文字行块；首次文字准备时间、解析完成、独立 CLI 墙钟耗时与 Linux 进程峰 RSS 分别记录。首次文字时间是内部准备时刻，当前 CLI 在结束时一次返回，不代表交互首批候选延迟。[定位预览](docs/acceptance/s3/runs/2026-11-02T14-41-35-628654Z/localization-previews/index.json) 提供原页叠框供人工核对；工程坐标断言通过不能替代真实原页人工忠实度验收。

[完整 Docling 2.145.0 原生 CPU 探测](docs/acceptance/s3/standard/2026-11-02T14-44-31-863991Z/result.json) 是另一份候选证据，启用版面/表格模型、关闭 OCR 和远程服务；模型来源、许可、提交与文件哈希分别记录。这是此前原生探测的历史证据；本轮另已接入v3适配和Pi，仍未通过表格、文字或阅读顺序人类质量验收。首篇包含模型初始化，后四篇复用模型；累计峰 RSS 和纯文字后端的独立进程峰值不可直接当作同条件对照。L01/L02 第1页出现密集矢量分隔符回退，警告完整保留在 [原生探测日志](docs/acceptance/s3/standard-probe-console.log)。

MinerU 4.1.4 已在独立 `.tools/mineru-venv` 安装并实际运行 basic/ONNX CPU；与完整Docling在同5篇41页做20次原生冷热/复用对照，最高进程树RSS分别约4.18/2.62 GiB。两路共享原文字行锚点，不能用共同source blocks证明native完整性。41页已完成AI图片巡视，其中10页深入正文/表格/图注对照；明确发现原生表格错格、图注错挂与文章边界风险。正式Docling主用已由用户确认，MinerU保留对照；S2/S3质量均未通过；S4已另行工程开工，S5未启动。当前入口为[正式选型](docs/acceptance/s3/parser-selection-2026-11-03/index.html)，决定前快照为[中文比较报告（HTML）](docs/acceptance/s3/comparison-2026-11-02/index.html)、[Markdown与命令](docs/acceptance/s3/comparison-2026-11-02/README.md)、[检查汇总](docs/acceptance/s3/comparison-2026-11-02/checks.json)。此前[原型交付记录](docs/acceptance/s3/engineering-delivery.json)作为当时状态保留。

最终工程原型审查为 3/3，允许交付本轮原型；S3 阶段和医学质量仍未通过，同一 S3 任务后续交接不得重置次数。此前[S3最小交付索引](docs/acceptance/s3/README.md)保持历史状态；当前已完成不依赖S2的双候选工程接入与开发对照，详见[本轮交付](docs/acceptance/s3/comparison-2026-11-02/engineering-delivery.json)。


## 正式主解析器调用

受信Node调用方使用`createConfiguredPdfParserAdapter()`读取固定`config/pdf-parser.json`（Docling默认），`createConfiguredPdfParserAdapter({candidateId: "mineru-basic-onnx-cpu"})`显式走对照。配置与用户决定SHA绑定；无模型可写的候选/路径参数。`verify:s3:pi`不传`--candidate-id`时采用正式配置；直接Python结构化CLI仍要求显式候选。

```bash
bash scripts/with-node.sh npm run verify:s3:pi -- --documents L01
# 显式对照：加 --candidate-id mineru-basic-onnx-cpu
```

该入口验证真实解析/来源读取，使用本机脚本模型，医学候选提交仍明确未实现。需要避免重新解析时可按[选型交付说明](docs/acceptance/s3/parser-selection-2026-11-03/README.md)复用既有真实结果；两种方式均不调用付费LLM。


## S4工程开工

当前S4为`engineering_in_progress / quality_pending / stage_passed=false`；[授权与历史保护](docs/acceptance/s4/engineering-start-authorization.json)、[计划条款映射](docs/acceptance/s4/implementation-plan.json)、[正式审查](docs/acceptance/s4/review-index.json)。两模型同medium仅开发对照，正式模型、医学目录及数值门槛待共同确定。现有S3读取入口继续保持只读探测语义；S4已新增真实候选保存、源证据校验、覆盖账本及单篇汇总接口；本轮开发对照进行中。S3读取入口与封存历史保持原语义。

当前结果从[中文阅览报告](docs/acceptance/s4/index.html)进入；逐候选可查分段原文、物理页码、整行框、待核状态、模型和策略，失败及被新运行替代的历史尝试单列。源码快照、运行文件和总账本位于[实验登记](docs/acceptance/s4/experiment-register.json)指向的独立`runtime-data/s4/`批次。报告是开发证据；完整人工金标未就绪，精确率/召回率不可评估，候选数量不用于选优。

`runExtractionDocument`使用版本化真实DocumentIR，通过Pi仅开放五个业务工具。主机绑定任务身份并将模型选择的行索引还原成原始文字，模型不能传入或覆盖身份、批准或文本位置。每条记录仍保存[完整28字段](packages/contracts/src/extraction-evidence.ts)，模型只收到精简ID、版本和问题回执。整行引用不等于最小特征短语，多个片段仅作分段展示，不冒充连续原句。全文覆盖分别报告原始块、已读块、显式完成块、隔离疑区、失败遗漏和上下文重复曝光；送入prompt不等于完成。

正式医学目录当前不可用。真实开放抽取允许空目录并保留新术语待审核；真实严格模式要求有效且获批的所选条目/适用关系。开发目录只有受信调用方显式启用后才能使用，输出带`development_only`标记；S1模拟词表及S2待核材料不会自动变成正式医学规则。字面引用、数值单位和显式范围检查通过，也不表示完整医学语义已正确；自动检查、未批准的模型复核和人工批准独立记录。

L02物理第3页别篇续文区域按文件SHA、文本版本、页框隔离，原PDF不修改，隔离区域留下覆盖缺口。S3原生结构的文字、表格、图注关系仍未可信，不能用其错关联建立医学事实。单篇汇总在新会话读取全部候选；不同条件/冲突保留，后文补充形成有版本的建议，人工版本不被自动覆盖。跨论文查询和S5审核界面未实现。

当前已有两模型同版L01完整源块处理和全文汇总；26/17条候选均未获医学批准。后续汇总已离线改成可逆的唯一源片段表和字段引用，全量26/17候选的JSON深相等还原通过，字节减少约56.6%—56.9%；这不是实测token或费用降幅。独立语境策略必须重读[中立开发问题](docs/acceptance/s4/evidence-validation/semantic-audit-cases.json)的原句及上下文，再记录未批准判断，未执行的检查保持`not_run`。这些问题不预定采集参数、临床子句或视觉关联的医学答案。

[当前调用规模选项](docs/acceptance/s4/experiment-scale-options.json)保留原14条件与尚未运行项。真实API目前等待本轮范围选择；离线检查和报告可继续。选择保留原余量的单次Astra/L01独立review时，可在授权后用`--job-ids job-13 --max-jobs 1 --concurrency 1`准确选择登记条件，不改变其他pending任务，也不覆盖原运行。

以下检查仅用本地合成材料和loopback Responses服务，不调用付费API：

```bash
bash scripts/with-node.sh npm run check
bash scripts/with-node.sh npm run test:extraction
```

真实开发脚本只复用已曝光的五篇开发PDF解析结果，向既有AGICTO发送文本及上下文，不发送原PDF。以下命令会产生真实API用量，使用现有批次账本；先确认没有另一个矩阵/探针进程，禁止用两个进程同时拥有同一账本：

```bash
# 有限新协议探针；不得把合成结果当论文证据
bash scripts/with-node.sh node --import tsx scripts/probe-s4-closed-protocol.ts
# 只运行仍pending的开发条件；单进程共享预算，小并发最多2
bash scripts/with-node.sh npm run s4:development -- --max-jobs 2 --concurrency 2
# 只读刷新中文结果快照，不调用模型
python3 scripts/render-s4-report.py --pricing-file docs/acceptance/s4/pricing-assumptions.json
```

原始整组上限为400物理请求、200万输入tokens（缓存计入一次）、40万输出tokens（已含推理）；未知usage的失败请求保留保守预留，不能当0。操作保护值经主会话增量授权调整为每批最多16响应、每篇最多30分钟；[墙钟调整](docs/acceptance/s4/wall-clock-adjustment.json)仅将原起点累计上限120分钟延长为240分钟，起点及调用规模未重置。每请求仍最多120秒，短暂故障最多2次重试，触限保存partial。上述数值是本轮开发操作限制，不能当医学质量或性能验收阈值。

两候选SDK名义上下文元数据为1050000，应用估算上下文上限128000，本轮配置输出8192；AGICTO网关的大窗口能力未通过压力测试。预算使用独立32K级操作预留和本地payload保守估算，它不是供应商硬计量上界；实际usage超过预估会标出。实际账单始终`unknown`；[供应商价格假设](docs/acceptance/s4/pricing-assumptions.json)只用于有来源的情景估算，缓存优惠和账户适用性未确认。
