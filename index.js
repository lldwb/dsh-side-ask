/**
 * `dsh-side-ask` —— Host 半。
 *
 * 本插件的能力全部在浏览器半（`client.js`）：右侧栏标签、选中文字动作、标题栏入口，
 * 以及基于 `ctx.sessions.fork` 的分支会话。Host 半只做一件事：让这个 bundle 有一行
 * 可加载的 Loader 行，从而 `dsh.client` 的浏览器半会被模块清单发现并注入页面。
 *
 * 为什么不需要 Host 逻辑：
 * - 分支会话走客户端 `ctx.sessions.fork`（Remote），创建、归档、取消归档都是现有
 *   Remote 能力；
 * - 会话本身是普通会话，不新增服务、不新增工具、不写会话日志之外的数据。
 *
 * 因此 `apply()` 是空实现，且**不声明任何 Config**：本插件没有可配字段（保留/归档
 * 是每个分支会话自己的选择，存在浏览器 localStorage 里）。
 */

/** 包名（Host 行名）。 */
export const name = 'dsh-side-ask'

/**
 * 空实现：浏览器半在 `dsh.client` 清单里注册，不依赖任何 Host 服务。
 * @returns {void}
 */
export function apply() {}
