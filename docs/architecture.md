# 架构说明

## 组件与职责

| 组件 | 权威数据/职责 | 明确不负责 |
| --- | --- | --- |
| 桌面端（Tauri + React） | 房间 UI、本机 SQLite、文件导入导出、Key 管理、sidecar 生命周期 | 云端账号、云存档 |
| 房主客户端 | 命令校验、连续序号、事件时间戳、骰子随机数、广播和重连补发 | 主机迁移 |
| 玩家客户端 | 向房主提交命令、幂等应用确认事件、保存本机可见副本 | 为全房间排序事件 |
| Relay Worker / Durable Object | 建房、成员状态、WebRTC 信令、直连失败后的临时转发 | 聊天历史、模组正文、事件恢复 |
| Python sidecar | 输入规范化、分块、调用选定 provider、引用整理、Schema 校验 | 长期保存凭据或模组 |

## 房间与事件流

1. 客户端先生成房主 peer ID，再向中继源地址 `POST /v1/rooms` 提交该 ID。Worker 返回房间 ID、预留的房主 peer ID、房主令牌、加入令牌和完整 WebSocket URL。
2. 房主分享包含房间 ID、加入令牌、房主 peer ID 和 WebSocket URL 的邀请串。令牌位于首个 WebSocket `join` 帧中，不放入 URL。
3. 房主与每位玩家分别用 Worker 交换 WebRTC offer、answer 和 ICE candidate；ICE 使用 `stun:stun.cloudflare.com:3478`。
4. 有序 DataChannel 建立后走直连。8 秒内未建立、连接失败或断开时，同一逻辑消息改由 WebSocket `relay` 帧转发。
5. 玩家发送 command；房主把它转为版本化 `RoomEventV1`，分配 UUID、连续 sequence 和时间戳，先在本地保存，再广播确认事件。
6. 各客户端按 event ID 幂等写入 SQLite，并按 sequence 展示。重连客户端报告最后连续序号；房主将缺失事件编码成带校验和的 UTF-8 JSON，再按 32 KiB 分块补发，接收端支持乱序组装。

房主退出后不选举新房主，房间写入暂停；各客户端仍可查询和导出已经落到本机的内容。

## 沉浸式房间世界投影

房间中的地点、在场角色和 NPC 不是从完整模组同步出来的另一份可变数据库，而是由每个客户端按房主 sequence 重放确认事件得到的 `RoomWorldStateV1`：

| 权威事件 | 对房间世界的影响 |
| --- | --- |
| `module.switched` | 指定精确的 `moduleId + revision`，并清空上一模组的地点、NPC、角色位置和地点内容投影；房间角色卡继续保留 |
| `location.published` | 加入或更新一个玩家可见地点快照 |
| `location.entered` | 将一个已有角色移动到已公开地点 |
| `npc.published` | 让一个玩家可见 NPC 快照在已公开地点登场；后续在另一地点发布同一 NPC 会移动它 |
| 带 `locationId` 的 `content.revealed` | 将已公开线索或手记关联到已公开地点 |

只有房主可以公开地点和 NPC，且相关命令必须引用房间当前活动模组的精确修订。房主的场景控制从其本机 SQLite 模组库加载该修订；精确版本缺失时停止发布，而不是退回最新版本或把完整模组发给玩家。玩家进入地点时只能移动自己当前拥有的角色，地点必须已经公开；房主权威序列也会在从持久记录重建时重复校验这些约束。

地点与 NPC 的公开载荷是严格的最小快照，只包含实体 ID、名称以及手工填写的 `playerDescription`。模组中的 `description`、原文定位、NPC 身份、动机、特征和数值不会自动进入事件。空的 `playerDescription` 不会回退到 KP 私密描述，界面会阻止发布。

这些世界事件沿用现有全房间事件流：广播、SQLite 落库、断线补发和记录导出均面向所有成员，公开后无法撤销其他成员已经保存的副本。调查员“进入地点”只影响共享舞台和在场列表，不构成接收权限；定向可见需要未来引入可见性安全的事件/同步模型，不能靠客户端隐藏实现。

角色卡沿用既有 `character.updated` 全房间事件，其中仍包含背景、物品和备注等完整字段。地点舞台目前只渲染必要的在场信息，但这不是数据隔离：其他玩家的 SQLite 已经保存完整角色卡。若要实现“本人和 KP 可见、其他玩家只见公开名片”，必须让房主按接收者生成可验证的公开/私有事件视图并在重连补发时保持相同规则；首切片尚未实现这一协议。

当前地点背景由客户端根据地点 ID 选择一组内置 CSS 渐变，不存在图片资源引用。KP 上传背景图、本机资源库、图片哈希校验、P2P/中继资源分块及缺失资源补取均未实现，因此房间事件和 SQLite 中也不会保存地点图片。

## 存储边界

桌面 SQLite 保存房间配置、加入凭据、本机收到的 `RoomEventV1`、模组包和非敏感设置。房间世界直接从本机事件日志重建；玩家不会为地点或 NPC 获得完整模组表。浏览器 Vite 预览没有 Tauri 能力，会自动使用内存仓库，刷新后数据消失。

Codex 是桌面端默认解析 provider。Rust 先定位并检查本机 `codex.exe` 与登录状态，再把已验证的绝对路径传给 sidecar。sidecar 通过 stdin 向一次性 `codex exec` 任务发送抽取指令和当前文本分块；应用不读取 Codex 的登录文件或令牌，也不开放 HTTP 代理。DeepSeek Key 不进入 SQLite；只有用户明确选择 DeepSeek 时，Rust 才从 Windows Credential Manager 读取它，注入单次 stdin JSON 请求，随后从请求对象中移除。sidecar 的 Pydantic 配置使用 `SecretStr`，缓存接口不接受凭据。

Durable Object 不创建应用数据表或 KV 记录。随机 256 位房主令牌经带域分隔的 SHA-256 派生玩家加入令牌，再由加入令牌派生房间 ID；每次加入都可据此无状态验证房间、角色与预留的房主 peer ID。玩家不能从加入令牌反推房主令牌或冒充房主。在线成员只存在 WebSocket attachments 中；alarm 只负责关闭 15 秒内未认证的 socket。所有人离线或对象回收后，原凭据仍可重连；没有事件、聊天、signal 或 relay payload 持久化，Wrangler observability 默认关闭。

## 模组结构化管线

```text
粘贴文字 / TXT / Markdown / DOCX / 单文档 ZIP
                    │
              安全检查与规范化
                    │
          按标题/段落分块（带重叠）
                    │
       ┌─ 本机 Codex CLI + output Schema（默认）
       └─ DeepSeek Responses API（手动回退）
                    │
       实体合并、去重、交叉引用与来源定位
                    │
             Pydantic 完整包校验
                    │
      ready_for_review / needs_review 草稿
                    │
          人工编辑确认后保存/启用
```

`ModulePackageV1` 包含元数据、概览、来源文档、手动章节、场景、地点、NPC、线索、手记、建议检定、守秘人笔记、实体关系、原文定位和扩展字段。场景是叙事单元，地点是可复用实体，两者通过 ID 关联。解析器不自动生成章节。

真实文件支持：

- `.txt` / `.md`：UTF-8（含 BOM）、UTF-16 或 GB18030，统一 Unicode、换行和控制字符。
- `.docx`：按文档顺序转换标题、段落、列表和表格；忽略图片；拒绝宏、VBA、ActiveX、嵌入对象和 DTD。
- `.zip`：只允许恰好一个 `.txt`、`.md` 或 `.docx`，忽略 `__MACOSX`、`.DS_Store` 和 AppleDouble 元数据；拒绝路径穿越、符号链接、加密、多载荷及压缩炸弹特征。

单个源文件上限 25 MiB；普通 ZIP 最多 128 个目录项、总展开上限 50 MiB、单项上限 25 MiB、压缩比上限 500。DOCX 内部包使用独立的 Office 包检查上限。解析失败只重试当前分块；Codex 启动、登录、超时和非零退出属于不可自动重试错误，避免在故障状态下连续消耗额度。可恢复的结构错误耗尽重试后返回带 issue 的 `needs_review` 部分草稿，不自动启用。

Codex 任务在隔离临时目录中运行，使用临时会话、忽略用户配置与规则、禁用 shell/unified execution、Web 搜索、应用、插件和子代理并启用只读沙箱；正文作为 stdin JSON 的单独 `source_text` 数据字段传入，静态抽取规则使用更高优先级的 developer instructions。最终 JSON 同时经过 CLI 严格输出 Schema 和 Pydantic 校验。Python sidecar 及其 Codex 后代加入 Windows kill-on-close Job Object，超时或桌面进程退出时会回收整棵进程树。推理仍发生在 OpenAI 云端。只读沙箱限制写入，但不等同于严格的文件读取 allowlist；首版因此只把它作为当前桌面用户主动触发的本机能力，不提供公网反代接口。

## 信任与加密边界

直连 DataChannel 自带 DTLS。退回中继时，WSS 只提供客户端与 Cloudflare 之间的传输加密；首版没有由房间成员持有密钥的应用层 E2EE，因此平台和中继运营者理论上能检查正在转发的帧。自建 Worker 能缩小信任范围，但不会把协议变成端到端加密。

玩家数据库只能获得房间中实际广播的事件；当前事件流不区分受众，所以所有地点、NPC、角色位置和揭示事件都对全体成员可见。实现和后续改动都不得把完整房主模组作为同步快照发送给玩家；揭示内容应转换成只含玩家可见字段的单独房间事件。
