# 权限矩阵 — 用户管理与权限控制

> 状态：**已实现**（2026-09-15）。20 条规则、14 节设计都已落到代码：
> `src/auth.js`（OAuth + 会话）、`src/access.js`（全部权限判定）、`src/worker.js`（守卫与端点）、
> `schema.sql` + `migrations/0001-user-management.sql`、`public/app.js`（能力集门控与账号/成员 UI）。
> `npm test` 29 项覆盖拒绝路径，前端已在浏览器中实测匿名读写、成员门控与管理页。
>
> 本文档保留为**设计与决策记录**：`†` 标记的推导值已按推荐实现，仍可按文末「剩余待定项」调整。

## 图例

| 符号 | 含义 |
|---|---|
| ✅ / ❌ | 你的决定 |
| ✅† / ❌† | 由你的规则推导，**待你点头** |
| `?` | 仍未定，见「剩余待定项」 |
| `—` | 该关系对该操作不适用 |
| `R#` | 来自原始需求，编号见下 |

| 编号 | 原始需求 |
|---|---|
| R1 | 匿名用户可以查看 board |
| R2 | 匿名用户可以添加 notes |
| R3 | 普通用户加入 team 后可以访问该 team 下的所有 board |
| R4 | （成员）只能查看不能修改 ← **已作废，见问题 #4** |
| R5 | team 的 board 删除权限只有管理员拥有 |
| R6 | 普通用户可以创建 board |
| R7 | 普通用户可以删除自己创建的 board |
| R8 | team 的创建者默认为管理员角色 |

---

## 一、已确认的规则（全部决策汇总）

| # | 规则 |
|---|---|
| 1 | **不设全局管理员**，最高层级就是 Team Admin |
| 2 | Team Admin 在该 team 内拥有全部权限 —— **唯一的例外是「合并」**，见规则 8 |
| 3 | 创建 team 的用户自动成为该 team 的 Team Admin |
| 4 | 一个 team 可以有**多个** Team Admin；可指派、可撤销（**「流转」已被规则 18 取消**） |
| 5 | **Board 属于 Team**，该 team 的所有成员都能看到这个 team 的所有 board |
| 6 | 一个用户可以属于多个 team |
| 7 | **成员对自己创建的 note 拥有所有权**，可以修改和删除 |
| 8 | **Merge 权限只归 board 的创建人** —— Team Admin **没有**合并权（这是规则 2「全部权限」的唯一例外） |
| 9 | **Board 有可见性选项：`公开` / `仅团队`；默认 `公开`** |
| 10 | **成员不能自己恢复自己删掉的 board** —— 只有 TADMIN 能恢复 |
| 11 | **Board 创建者不能直接删除别人的 note** —— 只能通过合并 |
| 12 | **投票按用户，不按浏览器** |
| 13 | **匿名 note 可以修改** |
| 14 | **移除 `SITE_PASSCODE`** —— 身份交给 OAuth，可见性交给公开/仅团队 |
| 15 | **导出 team 数据只有 TADMIN 可以，成员不能导出** |
| 16 | **匿名 note 与成员添加的 note 同级** —— 增删改拖同等对待，同等计入统计与排序 |
| 17 | **匿名可以投票** —— 投票主体 = `me.identity`（登录用户 id，或签名匿名会话 id） |
| 18 | **取消「流转」** —— team 只保留「指派 / 撤销 Admin」两个操作 |
| 19 | **显示名允许自定义覆盖**（可以盖掉 OAuth 昵称） |
| 20 | **匿名会话过期后，其 note 的归属转移给该 board 的 owner** —— 见第九节的处理机制 |

### 1.1 全局规则：授权看「当前关系」，不看「历史身份」

两条前置条件贯穿全部判定：

```
note 写权限   = 能读 && (我是该 note 的 owner || 我是 TADMIN)
board 管理权  = 仍在队内 && (我是该 board 创建者 || 我是 TADMIN)
```

**所有权不授予访问权，访问权也不因历史身份而保留。** 推论（都是必须接受的后果，不是 bug）：

- 成员被移出 team 后，他仍然是历史 note 的 `owner_id`，但**读不到那个 board，所以改不了**；
- 同理，**建过 board 的成员被移出 team 后，他对那块 board 的改名 / 软删 / 改可见性 / 合并权一并失效**（`board 管理权` 里的「仍在队内」，见第九节 `managesBoard`）；
- 公开 board 翻成 `仅团队` 后，之前的匿名作者**同样失去对自己 note 的编辑权**；
- **例外：被移出的成员在「公开」board 上仍能编辑自己的 note** —— 公开 board 谁都读得到，`能读` 这一条仍然满足。这是有意为之：那是他自己写的内容，且 board 本就公开；
- **匿名会话过期后不再是孤儿**：其 note 按规则 20 转移给 board owner。

---

## 二、身份与会话层

权限判定的地基。当前代码里这一层只有「一个 HMAC 口令 token」（`src/worker.js:26-47`），要整体替换。

| 项 | 设计 |
|---|---|
| 登录 | OAuth 2.0，Google + GitHub；必须带 `state`（防 CSRF），建议加 PKCE |
| 账号唯一键 | `oauth_identities(provider, provider_user_id)` —— **不以 email 为合并依据**（GitHub 常无公开邮箱） |
| 登录会话 | `sessions` 行 + `retro_session` cookie，HttpOnly / SameSite=Lax / Secure，30 天 |
| 匿名会话 | `sessions` 行（`user_id IS NULL`）+ `retro_anon` cookie，**首次写操作时懒签发**，30 天。见下方说明 |
| 身份 | `me.identity` = 登录用户 id，或匿名会话 id；**匿名也有身份**（规则 13 的前提） |
| 登出 | `POST /api/auth/logout`：删 session 行 + 清 cookie |
| 角色新鲜度 | 角色**不进 token**，每次请求查 `team_members` —— 保证降权立即生效 |

**两个 cookie 分开命名**，不要复用现在的 `retro_auth`（它的语义是「口令会话」，且规则 14 已让口令退役）。

**fail-closed。** 现在的 `sessionValid` / `authed` 在没配密钥时直接 `return true`（`src/worker.js:34,44`）——「没配就全站开放」。OAuth 化之后这类 fallback 必须反过来：缺 secret、会话表异常、cookie 无法验签，一律拒绝。

**401 与 403 必须分开**，现在客户端把任何 401 都当成「会话过期 → 弹口令锁屏」（`public/app.js:180-182`），且首页一加载就调 `/api/teams`（`app.js:295`）：

| 状态 | 含义 | 前端行为 |
|---|---|---|
| 401 | 未登录 / 会话失效 | 引导登录（**不再是**口令锁屏） |
| 403 | 已识别身份，**且能读**，但无权做这个写操作 | toast 提示 + 按能力集隐藏按钮，**不跳登录** |
| 404 | 资源不存在，**或我没有读权限** | 与「不存在」同一套展示，不区分两者 |

**「读被拒」故意复用 404，不要用 403。** team 对非成员是完全不可见的（team 本身、team 的 board 列表、仅团队 board 都一样），返回 403 等于确认「这个东西存在、而且属于某个团队」。board id 只有 8 位（`rid(8)`）且限流尚未上线，这条不做就给枚举探测留了口子。判定顺序也因此固定：**先判 `canRead`，再判写权限**——读不到就直接 404，不再暴露该资源上还有哪些操作。

**规则 14 的连锁效果：** 站点口令同时也是一键全站急停开关（`wrangler secret put SITE_PASSCODE` 立刻锁掉所有人）。去掉之后就没有这个杠杆了，全站急停改由 Cloudflare 侧承担（暂停 Worker，或加一条 WAF 规则）。见问题 #2。

**匿名会话要懒签发（规则 17 带出的约束）。** 规则 17 让匿名也能投票，意味着匿名者必须有身份；但**不要在他第一次只读访问时就签发**——公开 board 的每个路过访客都会因此写一行 `sessions`，把「匿名写作者才占一行」放大成「所有匿名访客都占一行」。改成在**首次写操作**（加 note、投票）时才签发 cookie，只读访问完全不落库。

**登录时要把匿名身份下的归属迁过来。** 一个匿名访客写了 note、投了票，然后才登录，`me.identity` 就从匿名会话 id 变成 user id——不迁移的话，**他刚写的 note 自己改不了**（owner 对不上），**刚投的票也还挂在匿名身份上，他可以对同一条 note 再投一次**（票数虚高）。OAuth 回调成功、写入登录会话之后，同一批 SQL 再跑一次，这次的对象是当前匿名会话 id：

```sql
UPDATE notes SET owner_id = ?1 WHERE owner_id = ?2;   -- (user_id, 当前匿名会话 id)
UPDATE votes SET voter    = ?1 WHERE voter    = ?2;
DELETE FROM sessions WHERE id = ?2;
```

**匿名会话过期时按规则 20 处理。** 过期扫描（见问题 #10 的清理 cron）在删除过期匿名会话之前，先把它名下的 note 归属转给该 board 的 owner：

```sql
UPDATE notes SET owner_id = (SELECT created_by FROM boards WHERE boards.id = notes.board_id)
WHERE owner_id IN (SELECT id FROM sessions WHERE user_id IS NULL AND expires_at < ?);
```

两个边界要一并处理：**board 的 `created_by` 为 NULL（存量 board）时没有转移目标**，这些 note 退回「仅 TADMIN 可动」；**转移目标已不在 team 内**时同理，只有他自己和 TADMIN 能动。票怎么办见待定项 #8。

---

## 三、Board 可见性

可见性只影响「非成员能不能读」，**不改变成员在 team 内的角色矩阵**。

| | `公开`（新板默认） | `仅团队` |
|---|---|---|
| 谁能读 | 任何持有链接的人（含匿名、含搜索引擎） | 只有该 team 成员 |
| 匿名能加 / 改自己的 note | ✅（R2 + 规则 13） | ❌（读都读不到） |
| 成员的写权限 | 与可见性无关 | 同左 |
| 出现在 team 的 board 列表里 | 是（列表仍只对成员开放） | 是 |

**默认取 `公开` 的连锁效果（请注意）**：因为成员可以建 board（R6），所以**team 内部的 retro 默认就是链接可读的**——任何拿到链接的人都能读到这场 retro 的全部 note，含所有人的名字和投票。「仅团队」需要建板时主动选。

两个实现建议：
- **建 board 表单把可见性显式摆出来**（两个单选，默认选中「公开」），不要靠静默默认；
- **board 列表上给每个 board 加可见性徽标**（公开 🌐 / 仅团队 🔒）。

**存量迁移**：存量 board 一律置为 `public`。这与新默认值一致，而且也是必须的——存量 team 一个成员都没有，设成 `仅团队` 会让它们**谁都读不了**。

**判定写法**：一律用 `visibility !== 'team'` 而不是 `=== 'public'`，并且建表时给 `DEFAULT 'public'`。否则「迁移」与「上线」之间新建的 board 会是 NULL，被判成非公开。见问题 #9。

**两个副作用**：公开 board 翻成仅团队后，之前匿名写的 note 会锁进团队，**匿名作者从此看不到自己写的内容**（也改不了，见 1.1）；匿名的 WS 连接会在翻转瞬间失效，前端要能优雅处理。

---

## 四、读取

**（A）`公开` board**

| 操作 | 匿名 | 登录非成员 | 成员 | 创建者 | TADMIN |
|---|---|---|---|---|---|
| 读 board 内容 | ✅R1 | ✅† | ✅R3 | ✅ | ✅ |
| 读该 team 的 board 列表 | ❌† | ❌† | ✅R3 | ✅ | ✅ |
| 连接实时房间 `WS /api/boards/:id/ws` | ✅† | ✅† | ✅ | ✅ | ✅ |

**（B）`仅团队` board**

| 操作 | 匿名 | 登录非成员 | 成员 | 创建者 | TADMIN |
|---|---|---|---|---|---|
| 读 board 内容 | ❌ | ❌† | ✅R3 | ✅ | ✅ |
| 读该 team 的 board 列表 | ❌ | ❌ | ✅R3 | ✅ | ✅ |
| 连接实时房间 | ❌ | ❌ | ✅ | ✅ | ✅ |

**（共同）**

| 操作 | 匿名 | 登录非成员 | 成员 | 创建者 | TADMIN |
|---|---|---|---|---|---|
| 首页 · 查看「我的 team」 | ❌ | ✅† | ✅ | ✅ | ✅ |
| 首页 · 查看全站 team 列表 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 导出 team 数据（含全部 note 作者名） | ❌ | ❌ | ❌ | ❌ | ✅ |
| 查看回收站列表 | ❌ | ❌ | ❌ | ❌ | ✅ |

> 「board 列表」和「单个 board」是两个不同权限：匿名能打开别人发给他的**某个公开 board 链接**（R1），但**不能浏览这个 team 有哪些 board**。否则 team 链接就成了整个团队的读凭证。
>
> 「全站 team 列表」现在是**实际行为**（`GET /api/teams` 无过滤，`src/worker.js:142-149`）。规则 14 之后这个泄露从「有口令的人可见」变成**全网可见**，必须改成「我的 team」。
>
> 回收站的读取跟着规则 10 收成 TADMIN。

## 五、Team 管理

| 操作 | 匿名 | 登录非成员 | 成员 | TADMIN |
|---|---|---|---|---|
| 创建 team（创建者自动成为 TADMIN） | ❌† | ✅ | ✅ | — |
| 重命名 team | ❌ | ❌ | ❌ | ✅ |
| 删除 team（**级联清空该 team 所有 board / note / vote**） | ❌ | ❌ | ❌ | ✅ |
| 添加成员（把某个用户加进 team） | ❌ | ❌ | ❌ | ✅ |
| 移除成员 | ❌ | ❌ | ❌ | ✅ |
| 指派成员为 Admin（可多个） | ❌ | ❌ | ❌ | ✅ |
| 撤销某个成员的 Admin | ❌ | ❌ | ❌ | ✅ |
| ~~流转 team 所有权~~（规则 18 已取消此操作） | ❌ | ❌ | ❌ | ❌ |
| 主动退出 team | ❌ | ❌ | ? | ? |

> 「加入 team」的机制被定死了：**管理员主动添加**，没有自助加入、没有公开列表、没有审批流，team 对非成员不可见。
>
> **规则 18：取消「流转」后，Admin 体系只剩「指派 / 撤销」两个操作**，`teams.created_by` 退化为纯记录字段、不再带任何权限含义（多个 Admin 权限本来就完全相同，流转不产生权限差异）。代价是**没有全局管理员 + 没有流转 ⇒ 孤儿 team 只能靠「最后一个 TADMIN 离开前必须指派继承人」来避免**，这条约束因此从建议升级为硬要求（见问题 #2、#7）。

## 六、Board 生命周期

按「我与这个 board 的关系」阅读。

| 操作（对某个 board） | 我是该 board 的创建者 | 我是同 team 成员 | 我是该 team 的 TADMIN | 我是登录非成员 | 我是匿名访客 |
|---|---|---|---|---|---|
| 创建 board（在我是成员的 team 里） | ✅ | ✅R6 | ✅ | ❌ | ❌ |
| 改可见性（公开 ↔ 仅团队） | ✅ | ❌ | ✅ | ❌ | ❌ |
| 重命名 | ✅ | ❌ | ✅ | ❌ | ❌ |
| 删除（进回收站，可恢复） | ✅R7 | ❌ | ✅R5 | ❌ | ❌ |
| **彻底删除**（purge，不可恢复） | ❌† | ❌ | ✅ | ❌ | ❌ |
| 从回收站恢复 | ❌ | ❌ | ✅ | ❌ | ❌ |

> **「彻底删除」这格从 ✅† 改成了 ❌†。** 原文档里创建者能永久删除却不能恢复，方向是反的——**不可逆的操作比可逆的操作更开放**。既然规则 10 把「恢复」收给了 TADMIN，那「永久销毁」至少不能更宽松。所以：创建者可以软删（还能救），永久删除归 TADMIN。
>
> 规则 10 的 UX 后果：**成员删掉自己的 board 后必须找 TADMIN 才能恢复**，删除确认框要写明这一点。
>
> 规则 11 的后果：board 创建者的 moderation 工具**只有合并**，不能直接删别人的 note。
>
> 「改可见性」TADMIN 那格按规则 2（全权限）填 ✅。唯一顾虑是**放宽成公开会把其他成员写的 note 一起暴露给全网**，建议这一方向加二次确认。

## 七、Note

按「我与这条 note 的关系」阅读。「我是这条 note 的作者」对匿名也成立（规则 13，匿名有签名身份）。

| 操作 | 我是这条 note 的作者 | 我是该 board 的创建者 | 我是该 team 的 TADMIN | 我是同 team 其他成员 | 我是登录非成员 | 我是匿名访客（非作者） |
|---|---|---|---|---|---|---|
| 添加 note | ✅ | ✅ | ✅ | ✅ | ✅† | ✅R2 |
| 编辑 | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| 删除 | ✅† | ❌ | ✅ | ❌ | ❌ | ❌ |
| 拖动 / 跨列移动（影响所有人的视图） | ✅ | ✅ | ✅ | ✅ | ✅† | ✅ |
| 投票 | ✅† | ✅† | ✅ | ✅ | ✅† | ✅ |
| **合并**（会删除被合并的 note 及其票数） | ❌* | ✅ | ❌ | ❌ | ❌ | ❌ |

> **「编辑 / 删除」的 ✅ 全部以「能读到这个 board」为前置**（见 1.1）。表里列的是关系命中，实际判定是 `canRead && (...)`。
>
> **规则 16：匿名 note 与成员添加的 note 同级。** 「添加 / 编辑 / 删除 / 拖动」四行里匿名和成员走的是**同一条判定路径**，不为匿名单独降级；匿名写的 note 在 note 计数、排序、投票统计上与成员写的 note 完全同权，不需要在统计里区分来源。
>
> **唯一的例外是投票**（见下一段）——投票是**投票人身份**的问题，不是 note 的问题，规则 16 不覆盖它。

> **规则 17：匿名可以投票，投票主体是 `me.identity`** —— 登录用户用 user id，匿名用签名匿名会话 id。这样「投票按用户」（规则 12）在两种身份上都成立。
>
> **要接受的代价**：匿名身份就是一个 cookie，**清掉 cookie 就是新身份，可以再投一次**。所以「按用户」对登录用户是硬的，对匿名只是软的——它能防住「刷新页面重复投」这类无意重复，防不住有意刷票。已有的缓解手段是第二节的懒签发（不写操作不留身份）+ 问题 #3 的限流；如果将来刷票成为实际问题，可以在投票接口上单独加 IP 维度的限流。
>
> \* 「我是 note 作者」的合并权：只有他同时也是该 board 的创建者时才成立——那种情况走「board 创建者」列。
>
> **规则 8 + 规则 11 的效果**：board 创建者**唯一**的 moderation 手段是**合并**（他不能直接删别人的 note），而 TADMIN 反过来——**能直接删任何 note，但不能合并**。代价是被合并的 note 被硬删除（`src/worker.js:479-512`）、没有回收站、没有审计记录。见问题 #1。

## 八、会话控制

| 操作 | 匿名 | 登录非成员 | 成员 | 创建者 | TADMIN |
|---|---|---|---|---|---|
| 开始静默写作 timer（影响所有在线观看者） | ❌ | ❌ | ❌† | ✅† | ✅ |
| 停止 timer | ❌ | ❌ | ❌† | ✅† | ✅ |

> timer 按「与 merge 同级」填的（board 创建者 + TADMIN），普通成员 ❌†。现状是人人可点。

---

## 九、核心判定

一个请求解析一次，所有端点复用：

```js
// board → team → 我的角色，是全部权限判定的唯一来源
// me.identity = 登录用户 id 或匿名会话 id（匿名也有身份，规则 13）
async function boardAccess(env, me, boardId) {
  const board = await env.DB.prepare(
    "SELECT id, team_id, created_by, visibility FROM boards WHERE id = ?")
    .bind(boardId).first();
  if (!board) return null;

  const member = me?.userId ? await env.DB.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
    .bind(board.team_id, me.userId).first() : null;

  const isTeamAdmin    = member?.role === "admin";
  const isBoardCreator = !!me?.userId && board.created_by === me.userId;
  // visibility 用 !== 'team'，兼容迁移窗口里的 NULL（见问题 #9）
  const canRead = board.visibility !== "team" || !!member;

  // 写权限一律先过 canRead —— 所有权不授予访问权（见 1.1）
  const mayWriteOwn = (note) => canRead &&
    (note.owner_id === me?.identity || isTeamAdmin);

  // board 属于 team（规则 5）⇒ board 级管理要求「仍在队内」，
  // 光有 created_by 不够：被移出 team 的创建者不能继续管这块 board
  const managesBoard = !!member && isBoardCreator;

  return {
    board, member, isTeamAdmin, canRead,
    canWriteNote: canRead,                      // 能读就能写（含公开 board 上的匿名）
    canEditNote: mayWriteOwn,                   // 规则 7 + 11 + 13
    canDeleteNote: mayWriteOwn,
    canMoveNote: canRead,                       // 规则 16：与「加 note」同级
    canVote: canRead,                           // 规则 12 + 17：主体是 me.identity
    canRename:   isTeamAdmin || managesBoard,
    canDelete:   isTeamAdmin || managesBoard,        // 软删，可恢复
    canPurge:    isTeamAdmin,                        // 彻底删除，不可恢复
    canRestore:  isTeamAdmin,                        // 规则 10
    // 规则 8：合并只归 board owner，TADMIN 不在内（规则 2 的唯一例外）
    canMerge:    managesBoard,
    canSetVisibility: isTeamAdmin || managesBoard,
  };
}
```

> 注意 `canDeleteNote` 里**没有 board 创建者**——这是规则 11 的直接结果。
>
> **`managesBoard` 里的 `!!member` 是必须的。** 少了它，一个被移出 team 的成员仅凭 `created_by` 就还能改名、软删、**改可见性**——包括把自己已经读不到的「仅团队」board 翻成「公开」，把整个 team 的内容暴露到全网。
>
> **规则 8 的后果：board owner 离开 team 后，这块 board 就没人能合并了。** 这是有意的取舍——TADMIN 仍可直接删除单条 note（`mayWriteOwn` 含 `isTeamAdmin`），所以 moderation 能力没有缺口，只是失去了「合并」这个批量工具。

### 9.1 Team 级操作需要并列的 `teamAccess()`

`boardAccess()` 是 board 中心的，但下面 5 个端点**没有 board 可以查**：它们在现在的代码里根本不存在，是本次新增的，对账表也覆盖不到。缺了守卫，其中「指派 Admin」就是直接的提权入口。

```js
// 团队级判定：没有 board，只有 team_id
async function teamAccess(env, me, teamId) {
  const member = me?.userId ? await env.DB.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
    .bind(teamId, me.userId).first() : null;
  const isTeamAdmin = member?.role === "admin";
  return {
    member, isTeamAdmin,
    canView:         !!member,     // team 对非成员完全不可见 ⇒ 404
    canRename:       isTeamAdmin,
    canDelete:       isTeamAdmin,  // 级联清空整个 team
    canAddMember:    isTeamAdmin,
    canRemoveMember: isTeamAdmin,  // 不能移除最后一个 admin
    canGrantAdmin:   isTeamAdmin,  // 提权入口，最容易漏
    canRevokeAdmin:  isTeamAdmin,  // 不能撤销最后一个 admin
    canExport:       isTeamAdmin,  // 规则 15
  };
}
```

| 新端点 | 守卫 | 额外约束 |
|---|---|---|
| `POST /api/teams/:id/members` | `canAddMember` | 目标用户必须已存在 |
| `DELETE /api/teams/:id/members/:userId` | `canRemoveMember` | **不能移除最后一个 admin** |
| `PATCH /api/teams/:id/members/:userId` | `canGrantAdmin` / `canRevokeAdmin` | **不能撤销最后一个 admin** |
| `POST /api/teams/:id/leave` | 本人 | **最后一个 admin 必须先指派继承人** |
| `GET /api/me` | — | 返回我的身份与各 team 的角色，供前端做显隐 |

「不能移除 / 不能撤销 / 不能退出」是同一个约束的三个出口，**缺任何一个都能造出孤儿 team**（问题 #2）。

---

## 十、仍存在的问题

### 1. 合并是硬删除，且无痕；合并权与团队层级无关 🟠

规则 8 + 规则 11 让 **board 创建者只能通过合并来删别人的 note**，而合并（`src/worker.js:479-512`）会：

- 把被合并的 note 直接 `DELETE`，note 没有回收站（只有 board 有），**不可恢复**；
- **不留任何审计记录**，事后无法知道谁在什么时候合并掉了什么；
- 幸存 note 的作者仍是原主人，但正文里已混进别人的话，**作者归属失真**。

建议至少：合并前弹窗列出「将被删除的 N 条 note 及其作者」；再考虑给 note 加软删除和操作日志。

**规则 8 改成「只归 board owner」之后，这里还剩一个层级倒挂（需要确认）：** 一个普通成员只要**自己建过一块 board**，就能在那块 board 上合并掉 **TADMIN 的 note**——合并权现在完全由「谁是这块 board 的 owner」决定，与团队角色无关。而且 TADMIN 连反制的合并权都没有了（只有逐条删除）。这不是权限冲突（两条规则各自都自洽），但它是「普通成员的有效权限可以高于 TADMIN」的唯一一处。如果这不可接受，两个可选收口：把合并也加给 TADMIN 作为兜底，或把合并限成「只能合并包含自己 note 的组合」。

### 2. 没有全局管理员 + 没有站点口令 → 运维空洞扩大 🟠

规则 1 去掉了全局管理员，规则 14 又去掉了唯一的全站急停开关，合起来：

| 空洞 | 说明 |
|---|---|
| 存量数据无人认领 | 现有 team / board / note 全都没有归属，这些老 team 会变成**没有 TADMIN 的 team**，谁也管不了 |
| 孤儿 team 无法恢复 | 最后一个 TADMIN 注销或退出后永久无人可管理 |
| 垃圾/滥用内容无人清理 | 没有谁能删掉一个骚扰性的 team |
| **全站急停开关消失** | 原来 `wrangler secret put SITE_PASSCODE` 可以瞬间锁掉所有人 |

**存量数据在权限层的具体后果：老 board 会变成「冻结」状态。** 它们没有 `created_by`、对应的 team 也没有任何成员，于是 `managesBoard` 对所有人都为 false。结果：**公开可读、任何人都能往里写 note，但没有任何人能改名、删除或合并**——连上面被刷的垃圾都清不掉。所以**迁移不能只跑 `UPDATE boards SET visibility='public'` 就完事，必须同时给存量 team 指定 TADMIN**（见第十四节第 2 步）。

建议保留**带外的运维手段**（不属于角色体系，不违反规则 1）：一次性 SQL 指定存量归属 + 一个 `SITE_PASSCODE` 门控的运维端点（**保留代码路径但平时不设 secret**，只在事故时启用）。全站急停改由 Cloudflare 侧承担：暂停 Worker，或加一条 WAF 规则。同时加约束：**最后一个 TADMIN 不允许退出或注销，除非先指派继承人**（三个出口见 9.1）。

### 2.1 任一 TADMIN 都能删掉整个 team 🟡

规则 2 的「全部权限」包含删除 team，而删除是级联的——**清空该 team 所有 board / note / vote**（`src/worker.js:176-190`）。多个 Admin 平权 ⇒ **Admin A 可以一次性删掉 Admin B 和所有成员的全部工作**，且不可恢复。这符合「全部权限」，但值得在删除确认框里明确列出将被删除的 board 数量，别让它变成一个顺手点的按钮。

### 3. 滥用防护完全缺失 🔴

公开 board + 匿名可写 + 免注册 + **现在连站点口令也没有了** = 刷屏入口对全网开放。D1 免费额度只有 10 万行写入/天，被刷就等于全站停摆。

需要覆盖：匿名写 note、**匿名投票**（规则 17 之后这是新增的匿名写路径）、建 team、建 board 的限流（Cloudflare Rate Limiting / Turnstile）。另外公开 board 的 id 是唯一的读取屏障（`rid(8)`，31^8 ≈ 8.5×10¹¹），限流也必须覆盖匿名**读**，防止枚举扫描。

### 4. 文档里 R4「只能查看不能修改」必须作废 🟡

规则 7 已推翻 R4 的字面意思。新表述：

> 成员可以查看 team 内所有 board；可以添加 note；可以编辑和删除**自己创建**的 note；不能修改别人的 board、note 或 team 设置。

### 5. 登录用户（非成员）的权限可能比匿名还小 🟡

匿名能读公开 board、能加 note、能改自己的 note，而登录但非成员的 USER 原本在表里是空的。**已按「登录只增不减权限」填充（`†`，待确认）**：读和写 note 只看「链接 + board 可见性」，不看是否登录。登录与否只影响结构性操作（建 board / 改名 / 改可见性 / 删除 / 合并 / 导出 / 管理 team）。

规则 16（匿名与成员同级）也支持这个结论——note 层的权限不该因为「有没有登录」而分裂成两套。

### 6. ~~board 创建者离开 team 后，Merge 权归谁~~ ✅ 已解决

规则 8 把合并限定为 board owner，且 `managesBoard` 要求「仍在队内」。所以 **board owner 离开 team 后，这块 board 就没有合并权了** —— 不再回落到 TADMIN（规则 8 明确排除了 TADMIN）。moderation 没有断掉，因为 TADMIN 仍能逐条删除 note。

### 7. ~~「流转」与「指派多个 Admin」语义重叠~~ ✅ 已解决

规则 18 取消了「流转」，Admin 体系只剩「指派 / 撤销」。副作用：**`teams.created_by` 变成纯记录字段**，不再带任何权限含义。

还剩两个 Admin 体系内部的边界需要明确（与流转无关）：

- **两个 Admin 能不能互相撤销 / 互相踢出？** 建议允许——多个 Admin 本就是平权的；
- **「最后一个 TADMIN 离开前必须指派继承人」现在是硬要求**：因为没有全局管理员、也没有流转，孤儿 team 没有别的补救途径（见问题 #2）。

### 8. 认证层的实现约束 🟠

**（a）身份不能自报，显示名可以（规则 19）。**

::code-comment{title="[P0] 身份由客户端自报" body="GET board 用 ?voter= 查询参数（app.js:891,1469），note 创建/移动/投票在 body 里传 voter。任何人可以用别人的 voter 查询其投票状态，也能以别人的身份投票。身份必须改为服务端从会话推导；显示名（body.author）按规则 19 保留客户端可填。" file="/Users/linke/free-retro/src/worker.js" start=383 end=384 priority=0}

需要移除的调用点：`?voter=`（`public/app.js:891,1469`）、`body.voter`（`app.js:1082,1302,1429`），以及服务端的读取（`src/worker.js:301,306,384,521`）。**`body.author` 保留**（规则 19），但它只影响显示。

**（a-2）规则 19 的冒充风险：显示名可自定义 ⇒ 任何人可以把名字写成别人。** 三条约束把它控制在「只能骗眼睛、骗不到权限」：

1. **权限只看 `owner_id`，从不看显示名** —— 改名不会获得任何权限，冒充成功也只是视觉上像；
2. **显示名绑在账号上，不是每 note 自由文本**：登录用户在自己设置里覆盖一次，写进 `users` 表，之后所有 note 都用它；匿名沿用它原有的浏览器本地名字。不要在发 note 时让客户端逐条传任意名字；
3. **在「显示名字」开关打开的视图里，把 OAuth 身份一并露出来**（例如显示名下面一行小字标账号），让别人能识别出被冒充的情况。

不做约束的话，一个普通成员可以把名字改成「Team Admin」，在公开 board 上以管理员口吻发言。这不会提权，但会误导人。

**（b）存量归属需要认领，notes 和 votes 都要。** 现有 `notes.owner_id` 和 `votes.voter` 存的都是浏览器 uuid。只改主体不做认领的话，**所有历史 note 的作者登录后都改不了自己的 note**。在 OAuth 回调成功、写入会话之后执行一次：

```sql
UPDATE votes SET voter   = ? WHERE voter   = ?;   -- (user_id, 旧的浏览器 uuid)
UPDATE notes SET owner_id = ? WHERE owner_id = ?;
-- 旧的浏览器 uuid 从 localStorage 的 retro:voter 读取，之后清掉本地值
```

**（c）`notes.owner_id IS NULL` 的存量 note 归谁。** `schema.sql` 的注释是「NULL = legacy, editable by anyone」，`src/worker.js:306` 也把 NULL 当成「我的」。但新守卫 `note.owner_id === me.identity` 会让它们**除了 TADMIN 谁都改不了**。建议明确为 **TADMIN only**——在公开 board 上「任何人可编辑」实际等于「任何人都能删」。

**（d）匿名会话有效期决定「匿名 note 可改」和「匿名票」的有效期。** 匿名会话过期后，其 note 按**规则 20** 转移给 board owner（机制见第二节），所以 note 不再是孤儿。**票的处理还没定**，见待定项 #8。建议把匿名会话设为与登录会话一致（30 天），并在过期前给出提示。

### 9. 迁移与上线之间的窗口会让 `visibility` 变成 NULL 🟠

如果先跑 `ALTER TABLE` + `UPDATE` 再上线代码，中间新建的 board 会是 NULL。用 `=== 'public'` 判定就会把它们当成非公开，匿名和登录非成员都看不了。已改为 `visibility !== 'team'` + 建表 `DEFAULT 'public'`，见第三节。

### 10. `sessions` 表会无限增长 🟡

匿名会话意味着**每个匿名访客一行**，没有任何清理机制。需要一个清过期 session 的 cron（现有 cron 在 `src/worker.js:83-99`，可以合并进去）。注意这个 cron **不是纯粹删数据**——按规则 20，它必须先完成匿名 note 的归属转移，再删会话行，顺序反了归属就丢了：

```sql
-- 1) 先转移归属（见第二节的 SQL）  2) 再删过期会话
DELETE FROM sessions WHERE expires_at < ?;
```

### 11. 每请求鉴权带来 D1 读放大 🟡

`boardAccess()` 实际是 3 次查询（session→user、board、`team_members`），每个端点都要跑一遍，叠加端点自身的查询。D1 免费额度 500 万行读/天。第二节要求「降权立即生效」，意味着角色不能缓存在 cookie 里——这是**拿读放大换正确性**，需要确认接受这个取舍，否则就得改成「角色进 token + 定期失效」（降权会有延迟窗口）。

### 12. 30 天 cron 与「恢复仅 TADMIN」叠加 🟡

创建者删掉 board、TADMIN 没注意到 → 30 天后永久清除。既然恢复权已经收窄，宽限期值得再确认一次。

另一个小断点：`GET /api/boards/:id` 对已删除的 board 一律返回 404（`src/worker.js:294`），所以 **TADMIN 在决定恢复之前看不到 board 里有什么**，回收站只能盲选。要做回收站 UI 的话这个限制得放开——对 TADMIN 允许读已删除的 board（软删只是从列表和公开访问里摘掉，不是对管理员隐身）。

---

## 十一、剩余待定项

| # | 待定 | 推荐 |
|---|---|---|
| 1 | 添加成员是否需要对方接受 | 不需要，直接生效 |
| 2 | 同一人用 Google 和 GitHub 登录算一个还是两个账号 | 唯一键用 provider 组合，另做显式绑定入口 |
| 3 | 匿名会话有效期 | 30 天，与登录会话一致 |
| 4 | 登录非成员能否读写公开 board（问题 #5 已按「能」填 `†`） | 能，读和写只看链接 + 可见性 |
| 5 | 普通成员能不能自己开始 / 停止 timer（第八节已按「不能」填 `†`） | 不能，与合并同级，属主持权 |
| 6 | 成员能否主动退出 team（TADMIN 的约束见问题 #2、#7） | 能退出，但最后一个 TADMIN 必须先指派继承人 |
| 7 | 两个 Admin 能否互相撤销 / 互相踢出（问题 #7） | 允许，多个 Admin 本就平权 |
| 8 | 匿名会话过期后，其**票**怎么处理（note 已按规则 20 归 board owner） | 直接删除——否则留一张没人能撤销的永久票，且该人换新会话后能对同一条再投一次 |
| 9 | 投票要不要禁自投 | 禁。允许自投 + 匿名身份可轮换 ⇒ 票数只能当参考 |
| 10 | 合并权是否加回 TADMIN 作兜底（问题 #1 的层级倒挂） | 不加，保持「合并 = board owner 专属」 |

## 十二、代码现状 → 目标守卫

| 操作 | 代码位置 | 现状 | 目标守卫 |
|---|---|---|---|
| 读 board | `src/worker.js:298-312` | 口令持有者 | `visibility !== 'team' \|\| isMember` |
| team 列表 | `src/worker.js:142-149` | **返回全站所有 team** | `WHERE t.id IN (我的 team_members)` |
| team 的 board 列表 | `src/worker.js:194-210` | 口令持有者 | `isMember` |
| 回收站列表 | `src/worker.js:194-210`（`?trash=1`） | 口令持有者 | `isTeamAdmin`（规则 10） |
| **导出 team 数据** | `src/worker.js:213-247` | 口令持有者，含全体作者名 | `isTeamAdmin`（规则 15） |
| 创建 board | `src/worker.js:264-283` | 口令持有者；**不传 team_id 会挂到最老的 team** | 必须显式传 `team_id`（我是成员），`visibility` 缺省 `'public'` |
| 改可见性 | — | 端点不存在 | `isTeamAdmin \|\| managesBoard`，放宽方向二次确认 |
| 重命名 / 软删 board | `src/worker.js:314-321`, `367-371` | 口令持有者 | `isTeamAdmin \|\| managesBoard`（**`managesBoard` 含「仍在队内」**，见第九节） |
| 彻底删除 board | `src/worker.js:356-366` | 口令持有者 | `isTeamAdmin`（见第六节） |
| 恢复 board | `src/worker.js:347-351` | 口令持有者 | `isTeamAdmin`（规则 10） |
| 加 note | `src/worker.js:375-406` | 口令持有者（R2 允许匿名） | `canRead`，`owner_id` 取服务端会话身份 |
| 改 note | `src/worker.js:414-423` | **任何人可改任何人的** | `canRead && (owner \|\| isTeamAdmin)` |
| 删 note | `src/worker.js:425-432` | **任何人可删任何人的** | 同上（board 创建者 ❌，规则 11） |
| 移动 note | `src/worker.js:436-476` | 任何人可移动任何 note | `canRead`（规则 16：与「加 note」同级） |
| 合并 note | `src/worker.js:479-512` | 任何人；**会删掉别人的 note** | `managesBoard`（规则 8：**只归 board owner，TADMIN 不在内**） |
| 投票 | `src/worker.js:515-539` | 任何人，每浏览器一票 | `canRead`，主体改存 `me.identity`（规则 12 + 17） |
| 创建 team | `src/worker.js:151-160` | 任何人 | 已登录用户，创建者写入 `team_members(role='admin')` |
| 改 / 删 team | `src/worker.js:169-190` | 任何人 | `isTeamAdmin` |
| timer | `src/worker.js:325-344` | 任何人 | `isBoardCreator \|\| isTeamAdmin` |
| WS 房间 | `src/worker.js:134-139` | 凭证可走 `?token=`（进日志/referrer） | 同「读 board」，改用 cookie |
| 站点口令 | `src/worker.js:26-47,108-131` | 全站门 + fail-open fallback | **整体移除**（规则 14），改为 fail-closed 的会话校验 |

**前端现状**：零权限门控，编辑 / 删除 / 投票 / 拖动全部无条件渲染（`public/app.js:1336-1351`）。服务端算的 `mine` 字段（`src/worker.js:306`）**客户端从来没用过**（只在乐观插入时写过一次，`app.js:1071`）——把它升级成真正的权限字段是前端做门控最省事的路径。

**规则 15（导出仅 TADMIN）的两处改动**：服务端在 `GET /api/teams/:id/export` 加 `isTeamAdmin` 校验；前端导出按钮现在无条件渲染（`public/app.js:409-431`，含移动端菜单里那个 `Export` 项），要一并收成只在 TADMIN 视角出现。成员看得见 board 内容却看不到导出按钮，UI 上不需要额外解释，但**别只靠隐藏按钮**——接口必须独立校验。

**规则 16（匿名与成员同级）在统计和排序上不需要改代码**：现在没有任何按作者身份区分的地方——`note_count`、`vote_count`、`last_activity` 都是纯 `COUNT` / `MAX`，排序只看 `sort_order`（`public/app.js:1138`）。所以规则 16 要改的只是**写权限的判定路径**（不要为匿名单独降级），统计口径保持现状即可。

## 十三、schema 变更

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_identities (
  provider TEXT NOT NULL,               -- 'google' | 'github'
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,                         -- NULL = 匿名会话（规则 13、17）
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
CREATE TABLE team_members (
  team_id TEXT NOT NULL, user_id TEXT NOT NULL,
  role TEXT NOT NULL,                   -- 'admin' | 'member'
  added_by TEXT, added_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

ALTER TABLE boards ADD COLUMN visibility TEXT DEFAULT 'public';  -- 'public' | 'team'
UPDATE boards SET visibility = 'public';                         -- 存量一律公开
ALTER TABLE teams  ADD COLUMN created_by TEXT;                   -- 存量行留 NULL
ALTER TABLE boards ADD COLUMN created_by TEXT;                   -- 存量行留 NULL
```

**`notes.owner_id` 和 `votes.voter` 都直接复用，不加列。** `notes.owner_id` 已经存在，注释写的就是「voter id of the creator」（`schema.sql`）——语义完全一致，只是存的值要从可伪造的 localStorage uuid 换成**服务端签发的身份**（`me.identity` = 登录用户 id 或匿名会话 id）。`votes.voter` 同理，主体也换成 `me.identity`（规则 17 让匿名也能投票），存量行按问题 #8b 认领即可。

## 十四、上线顺序（规则 14 的关键约束）

**不要先删口令再上 OAuth。** 中间窗口里整站没有任何门——既没有口令，也没有 OAuth。

| 步骤 | 内容 |
|---|---|
| 1 | 上 OAuth 与 `sessions`（**暂时保留口令作为过渡门**，OAuth 用户与口令用户并存） |
| 2 | 迁移 schema。**必须同时给每个存量 team 指定 TADMIN**，不能只跑 `UPDATE boards SET visibility='public'` —— 否则老 board 没有 owner 也没有管理员，会变成「能读能写、但没人能改名/删除/合并」的冻结状态（问题 #2） |
| 3 | 挂上各端点的权限守卫（含 9.1 的 5 个新端点），前端接入能力集与 401 / 403 / 404 分流 |
| 4 | 存量 note / vote 归属认领（问题 #8b），以及在 **OAuth 回调里加匿名归属迁移**（第二节） |
| 5 | 加两个 cron：清过期 `sessions`（**先转移匿名 note 归属、再删会话行**，规则 20）+ 原有的 30 天回收站清理 |
| 6 | **最后**移除口令：删代码路径、清 `.dev.vars`、`wrangler secret delete SITE_PASSCODE` |

规则 14 还会连带影响三个地方，第 5 步要一起改：

- **`README.md`**：部署步骤里的 `wrangler secret put SITE_PASSCODE`、以及整个「Site passcode」小节都要重写；
- **`test/api.test.mjs`**：现在靠 `TEST_PASSCODE` / `.dev.vars` 拿会话（第 3,11,50-62 行），`auth: unauthenticated API is rejected`（第 74 行）和 `ws: handshake requires a session token`（第 214-225 行）都建立在口令模型上，要去掉后改成直接造 session；其中 `test/api.test.mjs:126`「any voter may edit any note (open permission)」这条断言需要反转；
- **`.dev.vars`**：清掉 `SITE_PASSCODE`。
