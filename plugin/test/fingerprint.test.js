/**
 * 内容指纹的单测。
 *
 * 关键语义：**只对真实改动作出反应**。
 * BOM 与换行的变化不该让文档"变成新版"（git autocrlf / 编辑器加 BOM 都是常态）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { FINGERPRINT_HEX_LENGTH, fingerprintOf, isFingerprint } from '../docs/fingerprint.js'

test('指纹是 8 位十六进制', () => {
  const fp = fingerprintOf('hello')
  assert.equal(fp.length, FINGERPRINT_HEX_LENGTH)
  assert.match(fp, /^[0-9a-f]{8}$/)
  assert.equal(isFingerprint(fp), true)
})

test('同样的内容 → 同样的指纹', () => {
  assert.equal(fingerprintOf('abc'), fingerprintOf('abc'))
})

test('内容变了 → 指纹变了', () => {
  assert.notEqual(fingerprintOf('abc'), fingerprintOf('abd'))
})

test('**BOM 不影响指纹**（编辑器加 BOM 不该算"文档变了"）', () => {
  assert.equal(fingerprintOf('\uFEFFabc'), fingerprintOf('abc'))
})

test('**CRLF 与 LF 等价**（git core.autocrlf 不该制造假失效）', () => {
  assert.equal(fingerprintOf('a\r\nb\r\n'), fingerprintOf('a\nb\n'))
})

test('末尾空行的增减是真实编辑，指纹要变', () => {
  assert.notEqual(fingerprintOf('a\n'), fingerprintOf('a\n\n'))
})

test('中文内容可用（UTF-8）', () => {
  const fp = fingerprintOf('中文内容')
  assert.match(fp, /^[0-9a-f]{8}$/)
})

test('空字符串与非字符串不抛', () => {
  assert.match(fingerprintOf(''), /^[0-9a-f]{8}$/)
  assert.match(fingerprintOf(null), /^[0-9a-f]{8}$/)
  assert.match(fingerprintOf(undefined), /^[0-9a-f]{8}$/)
})

test('大文本也能算（不依赖长度）', () => {
  const big = 'x'.repeat(200000)
  assert.match(fingerprintOf(big), /^[0-9a-f]{8}$/)
})

test('isFingerprint 对非法值返回 false', () => {
  assert.equal(isFingerprint('abc'), false)
  assert.equal(isFingerprint('zzzzzzzz'), false)
  assert.equal(isFingerprint(null), false)
  assert.equal(isFingerprint(12345678), false)
})
