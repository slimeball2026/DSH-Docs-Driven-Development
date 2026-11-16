/**
 * 内容指纹（node:crypto）。
 *
 * 用途（SPEC §6.3 / §9.3）：判断"我读的这版"和"磁盘上这版"是不是同一份。
 * 语义对齐 `dsh-fs-observation-policy` 的 `FS_STALE_VERSION`，只是把"版本"换成"指纹"，
 * 且**不依赖那个默认关闭的策略插件**。
 *
 * 为什么用内容 hash 而不是 mtime/size：
 * - mtime 会被 `git checkout`、touch、编辑器保存抖动，产生假失效；
 * - 内容 hash 只对真实改动作出反应，正是我们要的语义。
 *
 * 取 8 位十六进制（SPEC §5.2 的 `fingerprint: string（8 hex）`）。
 */

import { createHash } from 'node:crypto'

/** 指纹长度（十六进制字符数）。 */
export const FINGERPRINT_HEX_LENGTH = 8

/**
 * 计算内容指纹。
 *
 * 只做两处归一化，都是"不该算作变化"的：
 * 1. 剥掉 BOM —— 编辑器加不加 BOM 不该让文档"变成新版"；
 * 2. 统一换行符 —— git 的 `core.autocrlf` 会让同一份内容在盘上呈现 CRLF/LF 两种形态。
 *
 * 不做 trim：末尾空行的增减是真实编辑。
 *
 * @param {string} content 文件全文
 * @returns {string} 8 位十六进制
 */
export function fingerprintOf(content) {
  const text = typeof content === 'string' ? content : ''
  const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n')
  return createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_LENGTH)
}

/**
 * 指纹是否有效（8 位十六进制）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFingerprint(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value)
}
