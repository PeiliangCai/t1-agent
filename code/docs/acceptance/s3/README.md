# S3 工程原型交付索引

可运行的本地 PDF 文字解析与定位原型已交付。**S3 仍为 engineering_in_progress、stage_passed=false**；S2 人工金标/医学复核等继续待办，S4/S5 本轮未启动。原验收要求保留，正式解析器尚未确定。

- [开工授权与保留的验收依赖](engineering-start-authorization.json)：保留用户原话，仅调整工程开工顺序。
- [工程交付明细](engineering-delivery.json)：实现、实测、候选状态、检查与剩余事项。
- [5 份真实开发 PDF 解析实测](runs/2026-11-02T14-41-35-628654Z/summary.json)：共 41 页、3887 个文字行块，未用于独立验收；原件 SHA 不变。
- [L01 精确片段定位示例](runs/2026-11-02T14-41-35-628654Z/L01.location.json)及[原页叠框](runs/2026-11-02T14-41-35-628654Z/localization-previews/L01-physical-page-1.png)：整行框，供人工原页核对，尚未通过忠实度验收。
- [最终检查](checks/2026-11-02T14-47-06-118650Z/result.json)：Python 9 项、TS 解析 6 项、既有单元 15 项/集成 8 项/评价 28 项通过；类型检查和前端构建通过。
- [完整 Docling 原生 CPU 探测](standard/2026-11-02T14-44-31-863991Z/result.json)与[原始日志](standard-probe-console.log)：5 份结果均保留；L01/L02 第1页有阅读顺序回退警告。原生结果未映射为项目适配、未通过人工表格/阅读顺序核验。
- [候选状态与边界](candidate-status.json)：文字后端适配已运行；完整 Docling 为另一次原生探测；MinerU 仅官方核验，未安装或实测。
- [最终工程审查 3/3](final-review.json)及[审查历史](review-progress.json)：只允许本轮工程原型交付，同一 S3 任务次数不重置；S2 仍 2/3，旧 S0/S1 3/3 封存。
- [版本清单](version-manifest.json)、[原件/历史与计划保留证明](final-integrity.json)、[可复现命令与接口说明](../../../README.md)。

跨块 `quote`/`raw_quote` 是按显式 `joiner` 形成的展示组合；权威引文是各段源文及 `segments` 边界。下游必须保留边界，不能把组合误当连续原文；当前尚未接入候选提交。

轻量文字后端约 0.83–1.34 秒/篇，指标为独立 CLI 进程；完整 Docling 首篇约 19.03 秒包含模型初始化，其余约 3.21–13.83 秒复用模型、RSS 为进程累计峰值。两者能力与计时/资源口径不同，不能冒充同条件质量对照。

后续继续补齐人工原页忠实度、文字/阅读顺序/表格核验，S2 完整金标、医学复核、规则细则、正式分组与独立验收封存，再做可比候选对照并共同确定正式解析器与最终门槛。现阶段无须仓促定案。
