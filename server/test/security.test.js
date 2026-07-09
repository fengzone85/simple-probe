'use strict';
// 核心安全函数单元测试（node:test 内置，无第三方依赖）。
// 隔离 DB：auth.js 依赖 db 模块会在加载时打开 SQLite，这里用 :memory: 避免污染真实库。
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const test = require('node:test');
const assert = require('node:assert');

const { totp, verifyTOTP, generateSecret } = require('../src/totp');
const auth = require('../src/auth');
const { validateReport, num, str } = require('../src/validate');

// ============================================================
// TOTP (RFC 6238 标准测试向量)
// secret = ASCII "12345678901234567890" 的 base32 编码
// ============================================================
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totp: RFC 6238 标准向量 (8 digits, SHA1, 30s)', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [ts, expected] of vectors) {
    assert.strictEqual(totp(SECRET, { digits: 8, timestamp: ts * 1000 }), expected,
      `TOTP mismatch at t=${ts}`);
  }
});

test('verifyTOTP: 接受当前码、±1 窗口，拒绝越界/非数字', () => {
  const t = 100000;
  const code = totp(SECRET, { timestamp: t * 1000 });
  assert.ok(verifyTOTP(SECRET, code, { timestamp: t * 1000 }));
  // 窗口 ±30s
  assert.ok(verifyTOTP(SECRET, code, { timestamp: (t + 30) * 1000 }));
  assert.ok(verifyTOTP(SECRET, code, { timestamp: (t - 30) * 1000 }));
  // 超出窗口（>90s）拒绝
  assert.ok(!verifyTOTP(SECRET, code, { timestamp: (t + 90) * 1000 }));
  // 非数字拒绝
  assert.ok(!verifyTOTP(SECRET, '12345a'));
  assert.ok(!verifyTOTP(SECRET, 'abcdef'));
  // 含空格被去除后仍匹配
  assert.ok(verifyTOTP(SECRET, code + ' ', { timestamp: t * 1000 }));
});

test('generateSecret: 返回合法 base32', () => {
  const s = generateSecret(20);
  assert.match(s, /^[A-Z2-7]+$/);
  assert.ok(s.length > 0);
});

// ============================================================
// auth.js: Token 比较与 Session Cookie
// ============================================================

test('safeEqual: 先哈希再比较，消除长度侧信道', () => {
  assert.ok(auth.safeEqual('secret-token-123', 'secret-token-123'));
  assert.ok(!auth.safeEqual('abc', 'abd'));
  // 不同长度必须能正确判否（不再「长度不等提前 return」泄露长度）
  assert.ok(!auth.safeEqual('short', 'a-much-longer-token-value'));
  assert.ok(auth.safeEqual('', ''));
  // 非字符串会被 String() 归一
  assert.ok(auth.safeEqual(123, '123'));
});

test('signSession/verifySession: 往返 + 篡改检测', () => {
  const payload = { role: 'admin', totp: true, exp: Date.now() + 3600_000 };
  const cookie = auth.signSession(payload);
  const back = auth.verifySession(cookie);
  assert.ok(back);
  assert.strictEqual(back.role, 'admin');
  assert.strictEqual(back.totp, true);
  // 篡改签名 → 拒绝
  const [body] = cookie.split('.');
  assert.strictEqual(auth.verifySession(body + '.deadbeef'), null);
  // 畸形
  assert.strictEqual(auth.verifySession('garbage'), null);
  assert.strictEqual(auth.verifySession(''), null);
  // 缺分隔符
  assert.strictEqual(auth.verifySession('novalidot'), null);
});

test('verifySession: 拒绝过期 payload', () => {
  const payload = { role: 'admin', exp: Date.now() - 1000 };
  const cookie = auth.signSession(payload);
  assert.strictEqual(auth.verifySession(cookie), null);
});

// ============================================================
// validate.js: 上报负载校验（注入/越界/约束防护）
// ============================================================

test('validateReport: 正常负载', () => {
  const m = validateReport({
    cpu: 50, mem_used: 1000, mem_total: 2000, mem_pct: 50,
    disk_used: 1, disk_total: 2, disk_pct: 50,
    load1: 1, load5: 2, load15: 3,
    net_rx_rate: 10, net_tx_rate: 20, net_rx_month: 1, net_tx_month: 2,
    uptime: 12345, temp: null, swap_used: 0, swap_total: 0, swap_pct: 0,
    probes: { '移动': { ms: 12, ok: true } },
    os: 'Linux', hostname: 'host1',
  });
  assert.strictEqual(m.cpu, 50);
  assert.strictEqual(m.mem_total, 2000);
  assert.strictEqual(m.temp, null);
  assert.deepStrictEqual(JSON.parse(m.probes), { '移动': { ms: 12, ok: true } });
});

test('validateReport: 缺失核心字段 → 该字段为 null（/report 路由据此拒收）', () => {
  // validateReport 本身始终返回对象，缺 cpu/mem_total 时对应字段为 null；
  // 真正的「整包拒绝」逻辑在 api.js 的 /report 路由（m.cpu===null || m.mem_total===null）。
  const a = validateReport({ mem_total: 100 });
  assert.strictEqual(a.cpu, null);          // 缺 cpu
  const b = validateReport({ cpu: 10 });
  assert.strictEqual(b.mem_total, null);    // 缺 mem_total
  // 非对象/非 null 直接返回 null
  assert.strictEqual(validateReport(null), null);
  assert.strictEqual(validateReport('string'), null);
  assert.strictEqual(validateReport(123), null);
});

test('validateReport: 越界/非有限数 → null', () => {
  const m = validateReport({ cpu: 200, mem_used: -5, mem_pct: 150, uptime: 1e20, mem_total: 100 });
  assert.strictEqual(m.cpu, null);
  assert.strictEqual(m.mem_used, null);
  assert.strictEqual(m.mem_pct, null);
  assert.strictEqual(m.uptime, null);
});

test('validateReport: 字符串数字可强制，非数字 → null', () => {
  const m = validateReport({ cpu: '50', mem_total: '100' });
  assert.strictEqual(m.cpu, 50);
  assert.strictEqual(m.mem_total, 100);
  const m2 = validateReport({ cpu: 'abc', mem_total: 100 });
  assert.strictEqual(m2.cpu, null);
});

test('validateReport: probes 约束（≤8 键 / label≤24 / ms 范围 / ok 强制布尔）', () => {
  // 超过 8 个键只取 8 个
  const many = {};
  for (let i = 0; i < 12; i++) many['k' + i] = { ms: 10, ok: true };
  const m = validateReport({ cpu: 1, mem_total: 1, probes: many });
  assert.strictEqual(Object.keys(JSON.parse(m.probes)).length, 8);

  // label > 24 字符的键被跳过
  const longLabel = {};
  const lk = 'x'.repeat(30);
  longLabel[lk] = { ms: 5, ok: true };
  const m2 = validateReport({ cpu: 1, mem_total: 1, probes: longLabel });
  assert.strictEqual(JSON.parse(m2.probes)[lk], undefined);

  // ms 越界 → null；ok 非 true → false
  const bad = { cpu: 1, mem_total: 1, probes: { a: { ms: 999999, ok: 'yes' }, b: { ms: 5, ok: true } } };
  const m3 = validateReport(bad);
  const p3 = JSON.parse(m3.probes);
  assert.strictEqual(p3.a.ms, null);
  assert.strictEqual(p3.a.ok, false);
  assert.strictEqual(p3.b.ok, true);

  // 非对象 probes / 数组 → 空对象串
  assert.strictEqual(validateReport({ cpu: 1, mem_total: 1, probes: 'x' }).probes, '{}');
  assert.strictEqual(validateReport({ cpu: 1, mem_total: 1, probes: [] }).probes, '{}');
});

test('validateReport: os/hostname 超长 → 空串（str 拒绝超长而非截断）', () => {
  const m = validateReport({ cpu: 1, mem_total: 1, os: 'x'.repeat(300), hostname: 'y'.repeat(300) });
  assert.strictEqual(m.os, '');
  assert.strictEqual(m.hostname, '');
});

test('num/str 边界', () => {
  assert.strictEqual(num(5, 0, 10), 5);
  assert.strictEqual(num('5', 0, 10), 5);
  assert.strictEqual(num(-1, 0, 10), null);
  assert.strictEqual(num(11, 0, 10), null);
  assert.strictEqual(num('abc', 0, 10), null);
  assert.strictEqual(num(NaN, 0, 10), null);
  assert.strictEqual(num(Infinity, 0, 10), null);
  assert.strictEqual(str('hi', 5), 'hi');
  assert.strictEqual(str('a'.repeat(10), 5), ''); // 超长 → 空串
  assert.strictEqual(str(123, 5), '');
});
