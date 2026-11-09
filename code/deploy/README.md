# T1 本机 Docker 交付

本部署将现有 Next 工作台、Fastify 和 Docling CPU 子进程装在同一应用容器。Next 的固定 `127.0.0.1:3210` 网关保持生效；仅将网页发布到宿主机 `127.0.0.1:30142`。克隆示例默认模型关闭，上传、原页查看、持久审核和导出可用。首版可配置默认模型已定为 AGICTO `gpt-6-luna`、medium、Responses，依据兼容与低价方向，不代表医学最优。正式医学目录仍未批准，B0 保持既有实现。

这是一个小型单机部署；SQLite 单应用实例写入。不要横向复制写服务，不要将宿主普通工作台和容器指向同一 SQLite/数据目录，不要将 30142 改成公网绑定。本次验收没有迁移或替换现有 30141/3210。

## 准备

在 `code/` 运行命令。需要 Linux x86_64、Docker Engine/Compose v2、至少 4 CPU 和 8 GiB 可用内存，构建需要网络和至少约 25 GiB 临时磁盘空间（30 GiB 更充足；依赖和多次构建缓存可额外占用）。镜像锁定 Node 24.22.2、Ubuntu 24.04 基础镜像摘要、npm lock 和 Python CPU lock；这提供可重复的构建步骤，系统 apt 安全更新仍可能随时间变化。

本机原无 Docker。验收使用现有 sudo 安装了发行版 `docker.io`、`docker-compose-v2`、`docker-buildx`，未向 docker 组加用户。当前普通账号运行 Docker 命令需 `sudo`；以下省略该前缀，备份脚本也可整体用 `sudo --preserve-env=...` 执行。发行版 Docker 包与 Docker 官方 CE 仓库安装方式不要混装。相关系统影响及实际版本见 S7 `system-impact.json`。

Docling 模型不烘焙在镜像中。既有 `.tools/pdf-parser/models` 可直接复用；启动前校验：

```sh
python3 deploy/docling-models.py verify .tools/pdf-parser/models
```

冷机器首次获取固定提交/固定 SHA 的约 530 MB 权重：

```sh
python3 deploy/docling-models.py download .tools/pdf-parser/models
```

下载只访问 Hugging Face 固定模型文件，不发送论文，不调用生成模型。中断产生 `.partial` 文件时先检查并仅移除该临时下载再重试；工具不会覆盖已有不同内容。没有网络时应事先复制这两个固定模型目录并通过相同 SHA 检查。未准备好模型时网页可启动，但不能声称 CPU 新解析可用。Docling 运行设置 CPU 4 线程、OCR 关、表结构开、远程服务关、Hugging Face/Transformers 离线；不会在产品运行中补下载权重。

## 构建与启动

```sh
docker compose build
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:30142/api/t1/workbench/capabilities
```

打开 `http://127.0.0.1:30142/`。远程机器用 SSH 转发访问，例如 `ssh -L 30142:127.0.0.1:30142 user@host`。公开部署、TLS、登录与多租户不包含在本交付。

若本机网络依赖 `127.0.0.1` HTTP 代理，Docker daemon 拉镜像需要单独复用该代理；构建阶段可使用 `docker build --network host --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY -t t1-workbench:local .`。不要将凭证写进 Dockerfile/构建参数。实际环境的无凭证本机代理仅配置给新增 Docker daemon，记录在 `system-impact.json`。构建上下文采用白名单，排除 `.env`、运行库、语料、历史验收材料、缓存及已有 node_modules/.next；两份小型、固定 SHA 的解析选择/模型别名证据随代码保留。

容器以 UID/GID 10001 运行，根文件系统只读、所有 capabilities 移除、无权限提升、PID 上限 512、内存上限 8 GiB、CPU 上限 4。`/tmp` 是 512 MiB 临时文件系统；SQLite、源 PDF、IR、整图、候选版本、审核、事件、导出及 CPU 原生结果均在专用 `t1-workbench-data` 卷的 `/app/runtime-data`。模型只读挂载。监督进程同时管理 Next/Fastify：任一退出就停止另一进程，正常 SIGTERM 最多给 65 秒清理，Compose 给 75 秒后停止。活动任务重启后保留已有成果并转中断；不自动恢复，用户新开任务从头。

查看日志与重启：

```sh
docker compose logs --tail 100 -f app
docker compose restart app
```

Docker JSON 日志每文件 10 MB、最多 3 份。持续业务事件另存 SQLite 并支持 SSE 游标重连。不要将 `docker inspect` 或渲染后的带凭证 Compose 输出贴入公开日志。健康检查同时请求内部 Fastify 和 Next 业务代理，表示服务可达与当前提取能力，不承载阶段验收或模型/医学质量结论。

## 数据与模型配置

可通过 `T1_COMPOSE_PROJECT`、`T1_IMAGE`、`T1_WEB_PORT`、`T1_DATA_VOLUME`、`T1_DOCLING_MODELS` 选择项目、镜像、loopback 端口、独立卷和模型目录。首次卷由镜像目录 UID 10001 初始化。既有宿主历史库依赖的外部 evaluation/docs 文件没有复制进新镜像；默认 `T1_IMPORT_RETAINED=false`，新部署为空库。不要只复制原 SQLite 后声称历史原件已迁移。

Compose 使用独立 `T1_DEPLOY_*` 名称，避免自动读取宿主 `.env` 的旧凭证/开关。按 `deploy/compose.env.example` 在私有配置中填写模型 key，并由服务端明确设置 `T1_DEPLOY_MODEL_ENABLED=true`。可用 `docker compose --env-file /private/path up -d`，不要把该文件提交或构建进镜像。预算为每新运行的 `T1_DEPLOY_MAX_REQUESTS`、`T1_DEPLOY_MAX_INPUT_TOKENS`、`T1_DEPLOY_MAX_OUTPUT_TOKENS`，默认 80/2000000/120000。固定两 FIFO 槽；第三个任务持久排队且可取消，等待时长单列。30 分钟从拿到执行槽开始，包括 PDF 解析、模型与 summary，排队不耗该时长；120 秒/请求、最多 2 次瞬态重试。token 是本地预留/回报预算，不是供应商账单绝对硬截断。浏览器不能扩大配置，只有用户点击开始才调用；上传与浏览不调用模型。每新 run 都建新账本，不继承旧实验额度。普通用户仍一次开始，无实验签字流程。

宿主普通服务使用既有私有 `code/.env` 中的 key，公开配置可分放 `deploy/local/workbench.env`，避免覆盖 key 字节：

```sh
mkdir -p deploy/local
cp deploy/host.env.example deploy/local/workbench.env
# 在私有配置中决定是否启用；示例保持 false。先确认旧实例无活动任务。
sh deploy/start-host.sh
```

脚本显式加载两个 env-file；后一个公开配置覆盖旧 provider/model/switch，key 不需重复。普通 `npm run dev:server` 本身不会自动加载 WORKBENCH 开关。不要同时启动第二个宿主写服务；实际服务切换由运维精确关闭旧 PID 后执行。新公开默认配置仍不授权任何旧实验脚本再次付费。

## 备份与空卷恢复

备份脚本短暂停止选中 Compose 项目的 app，流式打包整个数据卷，生成文件 SHA manifest，随后自动重启 app；这避免 SQLite/WAL 和源文件同时变化。模型、镜像和凭证不入备份；私下另外保存配置与镜像摘要。备份包含原论文及审核，应存放于私有目录。

```sh
mkdir -p deploy/backups
sh deploy/backup.sh deploy/backups/t1-20261109.tar.gz
sha256sum --check deploy/backups/t1-20261109.tar.gz.sha256
```

恢复总是指向一个新的空卷。工具拒绝被运行中容器挂载的目标、非空目标、路径逃逸、链接/特殊文件及 SHA 不符的归档，不覆盖原卷：

```sh
T1_DATA_VOLUME=t1-workbench-restored-20261109 sh deploy/restore.sh deploy/backups/t1-20261109.tar.gz
T1_DATA_VOLUME=t1-workbench-restored-20261109 docker compose up -d --force-recreate --wait
```

核对论文/独立 run、当前版本/审核和原 PDF 后再决定后续迁移。原 `t1-workbench-data` 卷仍保留，可用相同命令切回。恢复动作不产生新审批或自动恢复模型任务。不要执行 `docker compose down -v` 或全局 prune 来清理本项目。

## 上传至 T2 证据出口

上传逐篇 PDF，范围三层默认不限；批准目录未提供时受限范围不可用。模型未启用时开始按钮明确不可用。已配置时，开始新任务使用新 Docling CPU→既有 Pi/B0，进度与候选逐条持久化。复核时按当前版本重选原文/修改标签，禁止自由改写论文文字；文字批准与图片批准分别保存，图待核不阻止已确认文字导出。缺源或错 SHA 阻止新提取/已审核导出，历史仍可看。

`deploy/t2-evidence-contract.json` 固定 T2 接口边界。候选与已审核分别下载 JSONL、CSV、图文 tar.gz；图文包带 manifest、coverage、原文片段/页/bbox、版本、review、图注、整图及关系状态。T2 应先检查 manifest/coverage/reviews，并保留 run/source/version/fingerprint；候选或背景建议不能自动转为确认知识，同源分组不能合并或传播批准。文字确认不等于图文关系确认，图 IR 保真不等于医学批准。T2 消费方实现不属于本部署。没有候选时仍应如实交付空 JSONL/带表头 CSV/含 coverage 的包。

## 独立工程验收

仅验收时叠加 `-f compose.yaml -f deploy/compose.verify.yaml`，并显式设置独立 `T1_COMPOSE_PROJECT`、`T1_DATA_VOLUME`、`T1_WEB_PORT`。该入口使用全新人工 PDF、真实 CPU 解析、已装 Pi/B0 与固定本地 scripted Responses；不读取凭证、不调用外部生成服务。其人工审核只在隔离卷，不能当真实医学批准。恢复普通部署时不要带该覆盖文件。自动验收可在空闲 30142 上运行 `node deploy/verify.mjs`（需 Docker 权限），再次运行须设置全新 `T1_S7_VERIFY_ID`，保留旧卷不覆盖。实际执行结果、信号/重启/备份检查与未验证事项以 S7 `report.json` 为准。

医学目录由服务端可选 `T1_WORKBENCH_CATALOG_FILE` 指向符合 `EvidenceCatalogSchema` 的只读 JSON；容器需另外将该文件只读挂载并设置容器内路径。未配置仍为 unavailable，三层默认不限。文件须经真实授权批准且非 fixture，条目与同义词也须 approved；应用不提供、不自动批准医学目录。格式、审批状态或关联错误会阻止启动，不会退回不限。相同目录版本从工作流传至实际 B0 执行器，旧版本、空选择、无效 ID 保持拒绝；API 不返回配置路径或原始配置文件。更换目录需重启服务并刷新范围。

## 本轮实际交付状态（2026-11-09）

当前用户入口仍为 `http://127.0.0.1:30141/`。普通后端已加载最新来源字形守卫、FIFO 两槽、目录配置和终态保存修复，模型开关保持 **false**；上传、历史浏览、按来源守卫复核与导出可用。`deploy/local/workbench.env` 也已回置 false，私有 `.env` 原字节未变。本轮没有把模拟人工审核或 IN04 测试结果写入普通业务库。

容器部署、隔离卷持久化、活动任务中断、子进程故障、备份到新空卷恢复，以及人工 PDF 的 CPU→Pi/B0→候选/审核/导出检查实际通过。真实 IN04 首轮因 summary 契约停止；修复后唯一回归又因供应商返回未获确认的 `data-zone-standard-gpt-6-luna` 名称而被精确模型身份守卫停止。因此 **S7 的真实完整流程门槛未通过**，不把 UI 下载成功记作真实抽取完成，也没有放宽别名或继续付费。所有测试额度已关闭。最终事实和三种真实候选下载见 `docs/acceptance/finalization-2026-11-09/s7/report.json`。

源 PDF 的字形疑点会被隔离，不能作为已处理内容或交付引文；coverage 明示缺口。旧 IR 未做字形检查时仍可浏览，已审核出口保持保守守卫。新目录配置不替代真实医学批准。终态保存阶段会显示 reconciling，`result_ready=true` 后才给最终完成信息和导出，避免把较早的空 coverage 缓存在终态下。
