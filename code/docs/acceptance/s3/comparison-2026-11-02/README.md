# S3：无 GPU 的真实解析、定位及候选对照

记录时间：2026-11-03T00:09:41.166623+08:00。本批目录沿用2026-11-02开工日期；仍属同一个S3任务，正式审查3/3不重置。

**当前服务器无GPU也能完成这批资料的两种本地解析。** 完整Docling 2.145.0 CPU和MinerU 4.1.4 basic/ONNX CPU均实跑5篇、41物理页；各做5次新进程和同一模型进程内5篇连续解析，共20次原生运行。无付费LLM、无PDF外传、未改系统Python或实例规格。所有结果继续标为partial，表示原生结构和全文忠实度尚未验收。

建议优先考虑 **Docling完整CPU布局/表格 + 共用docling-parse原文锚点** 作为首版工程默认候选：抽查中文表格行列和逐格定位更适合当前来源要求，多数资料开销也更小；保留MinerU作为可替换的对照候选。它在部分页面的表/图分区、日期、旋转表方向更好，无法以单篇或计数断言整体更准。**正式解析器尚未选择，需用户结合下列证据共同确定；本报告不批准医学规则或S3质量通过。**

## 如何看这次比较

|维度|Docling完整CPU + 共用原文锚点|MinerU basic ONNX CPU + 共用原文锚点|
|---|---|---|
|原生文字/结构实际保留|正文、orig/text、表格cell、标题/图注、原生顺序/层级及多区域charspan保留；存在注释混正文、日期连线丢失、图注错挂和旋转表方向问题|正文、inline spans、原生HTML网格、标题/图注、图像和原生顺序保留；存在中文表头/数值错格、图组拆散、旋转表题入格和跨文章顺序交织|
|来源定位能否还原|共同原文字行底座；native逐格bbox可缩小单元匹配范围，逐段源引用可还原；不等于native表格逐格正确|同一底座可提供原页字行；公开middle JSON的HTML格没有独立格bbox，只有整表区域，重复短数字可能无法唯一定位|
|正文与引用关系|native可能去连字符、改空白；processed native/orig不冒称逐字原文；权威引用为原文blocks的码点segments|同样保留native加工文本和原文底座的区别；不得把底座补回的字记作MinerU原生完整|
|本次CPU配置|4线程、单PDF；OCR=false、表结构开启；无远程服务|4线程/1 inter-op、单PDF；basic+txt+ONNX/CPU；整页OCR未开，但表格管线实际调用本地OCR/公式模型|
|测得最高进程树RSS|2.61 GiB|4.18 GiB|
|尚未覆盖|扫描/需OCR混合页完整处理、所有表格/图组/医学语义、全量人工逐字核验|相同；此处未测试官方4.x的Standard/Advanced VLM模式、GPU或云端模式（[full]是安装extra而非层级）|

两路共享原文底座仅使来源可追溯，**不能证明两路native文字同样完整**。3887个原文字行、单位数、图/表个数、映射比例均为工程记账，绝非正确率。5篇都是已曝光开发资料，独立验收资料为0。

## 实际开销

|资料（物理页/文件MB）|Docling新进程 原生/整条旧适配 秒|MinerU新进程 原生/整条旧适配 秒|Docling复用 原生秒 / RSS GiB|MinerU复用 原生秒 / RSS GiB|
|---|---:|---:|---:|---:|
|MED03（9页/0.51）|33.13 / 34.81|21.39 / 23.45|33.25 / 1.97|21.14 / 2.96|
|L07（15页/1.82）|17.14 / 18.48|26.61 / 28.02|11.30 / 2.61|19.28 / 3.71|
|L05（10页/1.55）|28.95 / 30.31|31.29 / 32.55|22.65 / 2.59|22.69 / 3.76|
|L01（4页/1.49）|13.58 / 14.46|17.92 / 18.84|8.23 / 2.55|10.08 / 3.75|
|L02（3页/1.34）|11.07 / 11.84|30.29 / 31.08|5.55 / 2.25|22.82 / 4.18|

新进程不等于操作系统/模型文件冷盘，模型下载不计入；复用只复用模型，不读整份PDF的旧解析缓存，首篇MED03仍含模型加载。两路直接调用本地SDK，每篇重新解析原件。RSS为50ms采样的宿主+递归原生子进程总和；复用进程可能保留模型/缓存，另存ru_maxrss终身峰值，不能把它当本篇独占内存。CPU为进程用户/系统时间，不是耗时百分比；逐篇CPU、文件大小、源锚点/原生/映射分段及失败页见[CSV](comparison-data.csv)和[机器数据](comparison-data.json)。

20次运行均返回全体物理页native结果，无native异常或超8GiB退出；输出partial与未验证图像/结构、未匹配或有歧义来源相符。没有扫描页/OCR完整性的对照承诺。旧实测文件和native耗时不回写；最终guarded-v4 IR是复用原生工件、实际重跑来源映射/保护的派生结果，**不能把旧native时间加新mapping时间称当前端到端实测**。真实TS→CLI桥接另有实际运行记录；报告没有为改文字重跑20次基准。

## 三个可直接核对的原页例子

1. **L01物理第2页，表1。** 原页有效组病理值11/15/5，无效组13/5/1；Docling保留8列和这些抽查值，MinerU原生HTML合成7列，丢/错放15与13，性别头也变成“女 男”。[原页](page-review/v1/L01-p02-original.png)、[Docling网格](page-review/v1/L01-p02-docling-standard-cpu-table0-grid.png)、[MinerU网格](page-review/v1/L01-p02-mineru-basic-onnx-cpu-table0-grid.png)。两者都能给出表区框，但这不使错误网格可用。
2. **L05物理第6页，Table3和下方Fig.3。** Docling把表与nomogram包进同一表框，Fig.3误挂到表；项目明确标conflict/rejected，保留原生错误。MinerU分区/图注较好，但Bubble sign标签移到前一因素的56/66行。 [原页](page-review/v1/L05-p06-original.png)、[Docling叠框](page-review/v1/L05-p06-docling-standard-cpu-order.png)、[MinerU网格](page-review/v1/L05-p06-mineru-basic-onnx-cpu-table2-grid.png)。没有自动纠正医学关系。
3. **MED03物理第2页，左栏末段→右栏首段。** 两候选抽查均保留neoadjuvant→chemotherapy and colectomy的续接。Docling原生有两段charspan/框；修复项目映射按整页y错配的问题后，以23个源segments定位，保留跨栏边界。[原页](page-review/v1/MED03-p02-original.png)、[Docling叠框](page-review/v1/MED03-p02-docling-standard-cpu-order.png)、[MinerU叠框](page-review/v1/MED03-p02-mineru-basic-onnx-cpu-order.png)、[逐段来源](page-review/focused-evidence/MED03-p02-docling-standard-cpu-location.json)。拼接quote只是显式joiner的展示组合，不能当连续原文。

## 41页实际图片核验范围与剩余问题

已用view_image实际查看全部41页：本执行者10页重点正文/顺序/表格/图注对照，另执行者31页版面/内容存在性巡视；集合无重叠且覆盖全部页。原图、两候选native摘要/叠框、每条具体发现分别保存。[10页详细材料](page-review/v1/index.html)、[10页发现及确切引用](page-review/focused-findings.json)、[其余31页巡视](page-review/pi-executor-survey/survey-summary.json)、[全页覆盖索引](page-review/all-pages-review.json)。这属于AI工程核验，**没有人类/医生批准、逐字全文金标或全部单元格金标**；不能宣称100%忠实性。

- L02物理第2页表3：Docling保持7列，MinerU合成5列并将0.641分散到相邻格。MED03物理第4/5页旋转表，两路方向/表题/网格不同，全部格仍待核。
- L07物理第7页：Docling Fig.4图注错挂Springer小logo，真实MRI图无caption。类型保护和新增“长编号图注+远处极小图”几何保护拒绝此链接，但没有猜测改挂。该启发式不能解决所有同类图注/多面板归组。
- MED03物理第1页：Docling把author-information注释与第2页正文混成native单元。L07第4/6/8/9页、L05第8页存在半图注/多面板共享关系缺失；原生工件保留、结构一律不可直接用于医学解释。
- **L02物理第3页下半部“上接第38页”属于另一篇续文/参考文献。** 两路全页保留是覆盖事实，不能将该区域自动当本篇论文证据；MinerU顺序还把它插进本篇右栏参考文献之前。原件未裁剪/修补；文章区域排除尚未实现，后续S4需识别并人工核对。
- MinerU MED03的562个歧义单位全为table_cell，公开输出只给整表区域，516个文字长度≤3、其余也是区域内重复项。Docling逐格几何使该篇0歧义；这是出处精度与粒度差异，**不是两者文字准确率**。歧义格不给“第一个匹配”。[分解证据](ambiguous-anchor-breakdown.json)。

## 工程接入和复现

DocumentIR v1人工样例保持兼容；v2原文字行与v3结构均按候选/代码/配置/原工件SHA生成版本。物理页码、CropBox相对且已应用Rotate/UserUnit的左上角pt坐标、原始几何/转换、Unicode码点[开始,结束)偏移、native处理文本和原文segments分别保存。来源框精度是**整行**，native结构框是区域/格，不冒称字框。

真实Pi链路已可用这5篇PDF：受限的5个工具读取真实DocumentIR/来源，候选选择由调用端显式传入，模型不能选择任意本地路径；工具不把native工件路径当模型能力。真实SDK配本机脚本模型只验证调度/来源约束，**没有调用真实抽取LLM**。真实医学submit明确拒绝medical_candidate_submission_not_implemented，成功工程探针仍partial/候选0。[接入与验证索引](pi-integration/interface-and-validation.json)。HTTP上传/产品UI是S5，此轮未启动。

```bash
# 显式选择候选；改run-id/输出路径，旧工件不覆盖
bash scripts/with-node.sh npm run parse:pdf:structured -- \
  --candidate-id docling-standard-cpu --run-id local-new-run --document-id L01 \
  --file-reference evaluation/corpus/development-candidates/L01.pdf \
  --file-sha256 8f5e38ac6575cd776469506fece887e85acb95bf4df0d61ae489cc88cf0de267 \
  --output runtime-data/local-new-run/parser-result.json
# 可替换为mineru-basic-onnx-cpu；退出码2表示partial，1表示错误。
bash scripts/with-node.sh npm run verify:s3:pi -- --candidate-id docling-standard-cpu \
  --parser-result docs/acceptance/s3/comparison-2026-11-02/runs/guarded-v4/reuse/docling-standard-cpu/L01.json
```

需要重新测模型时运行`.venv/bin/python scripts/compare-s3-cpu.py --candidates docling-standard-cpu mineru-basic-onnx-cpu --output-directory docs/acceptance/s3/my-new-unique-cpu-comparison`；输出批次必须不存在，脚本拒绝覆盖旧批次。本次测量时脚本原始版本另存source-snapshots，不重复运行基准。最终回归与失败修复见[检查汇总](checks.json)。

## 版本、来源、许可与资源

Docling锁2.145.0/docling-parse7.24.2，完整标准CPU路径在`.venv`；MinerU固定4.1.4/basic ONNX，独立`.tools/mineru-venv`的116包锁定环境，没有CUDA/torch/full依赖覆盖旧环境。MinerU ONNX包858,220,651字节、固定commit `358310b4f64b95f9fefc372ad899356e4111f376`，下载并校验ready；压缩依赖222,257,914字节。项目解析环境/模型实际占用约4.34GiB，小于6GiB预算，详细最终盘点见[交付记录](engineering-delivery.json)。

官方来源在2026-11-02核验并固定快照：[MinerU发布/源码](https://github.com/opendatalab/MinerU/tree/6d6fc6008869f82f353fd169d903c02998140cbe)、[CPU模式文档](https://opendatalab.github.io/MinerU/usage/tiers/)、[模型来源](https://opendatalab.github.io/MinerU/usage/model_source/)、[PyPI4.1.4](https://pypi.org/project/mineru/4.1.4/)。MinerU源码LICENSE为Apache2并含商业阈值/在线署名条件；ONNX汇总repo无顶层license元数据而声明沿用原模型许可，逐一固定并核验5个原模型仓库的Apache2元数据，未把缺失元数据伪称已获法律批准。[模型许可来源与hash](model-license-verification.json)、[官方原始资料目录](sources/)。Docling本地代码/模型固定来源沿用[此前官方核验](../candidate-source-verification.json)。

## 待共同确定与质量验收

可选方向：A. Docling完整CPU+共用原文锚点为工程默认、MinerU保留对照（本报告建议）；B. 先保留双路显式选择，补查争议网格/图组后再定；C. 指定更重模式或其它资源做下一轮有界工程比较（需另谈资源/许可，不因无GPU默认扩大）。本轮未写入任何正式默认选择。

S2人工阅读全文金标、医学复核、正式分组、标注/计分细则仍pending；S3人类定位忠实度、错误边界处理及正式组件选择/质量验收仍pending。原E01—E09、数值阈值和阶段gate不变；S0/S1已验收保持，S2审查2/3、S3审查3/3保持，S4/S5尚未启动。此次交付解决无GPU可运行、真实工具链接通和可供选择的开发对照，不能替代原质量门槛。
