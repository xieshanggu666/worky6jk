// 供应商批次召回模块测试：
//  1) 发起召回（批次锁定/FEFO 自动隔离停售/食安投诉联动/事件通知/幂等）
//  2) 供应商应答（接受/异议/园方强制推进/超时通知）
//  3) 在库批次隔离 → 退回供应商（未付冲应付/已付现金应收）/ 结案销毁计损失
//  4) 已售退款：自营现金退款；联营分账红冲（不回库存不冲 COGS），批次成本/处置费随结算账单付商户
//  5) 供应商赔付（分次/超额拒绝）、结案评级暂停合作、投诉闭环、撤销
// 运行：node --experimental-sqlite --test server/recalls.test.js（需 Node >= 22.5）
process.env.PARK_DB_PATH = ':memory:'

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const P = await import('./procurement.js')
const R = await import('./recalls.js')
const PT = await import('./partners.js')

const finLogs = []
const events = []
const complaints = []
P.initProcurementContext({ logFinance: (...a) => finLogs.push(a) })
PT.initPartnerContext({
  logFinance: (...a) => finLogs.push(a),
  applyVendorSales: (id, q) => P.applyVendorSales(id, q, { partner: true }),
  customerReturn: (id, q, o) => P.customerReturn(id, q, { ...o, partner: true }),
  partnerCogs: (id, f, t) => P.partnerCogs(id, f, t),
  autoLinkVendor: (id, t) => P.autoLinkVendor(id, t)
})
R.initRecallContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  quarantineRecallBatch: P.quarantineRecallBatch,
  recallReturnBatch: P.recallReturnBatch,
  recallDestroyBatch: P.recallDestroyBatch,
  releaseRecallBatch: P.releaseRecallBatch,
  recallOutflow: P.recallOutflow,
  purchaseOutstanding: P.purchaseOutstanding,
  recordRecallReturnLine: P.recordRecallReturnLine,
  adjustSupplierRating: P.adjustSupplierRating,
  setSupplierStatus: P.setSupplierStatus,
  activePartnerContract: PT.activeContract,
  recordRecallChargeback: PT.recordRecallChargeback,
  createComplaint: (p) => {
    const id = (db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM complaints').get().n)
    db.prepare('INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('TS' + String(id).padStart(4, '0'), 100, 1, 'food', p.severity || 2, p.title, p.content || '', p.target?.type || '', p.target?.id ?? null, 'open', 999, 'manual')
    complaints.push({ ...p, id })
    return { id, code: 'TS' + String(id).padStart(4, '0') }
  },
  closeComplaintLinked: (cid) => closedComplaints.push(cid),
  emitEvent: (type, title, desc, impact) => events.push({ type, title, desc, impact })
})
const closedComplaints = []

const cash = () => Number(getSetting('cash'))
const matByName = n => P.listMaterials().find(m => m.name.includes(n))
const onHand = materialId => Number(db.prepare('SELECT qty_on_hand FROM inventory WHERE material_id=?').get(materialId)?.qty_on_hand || 0)
const finSum = (label, sign) => finLogs.filter(f => f.label === label)
  .reduce((s, f) => s + (sign === 'pos' ? Math.max(0, f.amount) : sign === 'neg' ? Math.min(0, f.amount) : f.amount), 0)

before(() => {
  setSetting('day', 1); setSetting('tick', 100); setSetting('cash', 500000)
})
beforeEach(() => {
  setSetting('day', 1); setSetting('tick', 100); setSetting('cash', 500000)
})

// 找一个供应商的在库批次（期初库存，supplier_id=首选供应商）
function batchOf(supplierId, materialId) {
  return db.prepare("SELECT * FROM inbound_batches WHERE supplier_id=? AND material_id=? AND status='in' AND qty_remain>0 ORDER BY id LIMIT 1")
    .get(supplierId, materialId)
}
function freshPo(supplierId, materialId, qty, unitCost) {
  const o = P.createOrder({ supplier_id: supplierId, items: [{ material_id: materialId, qty, unit_cost: unitCost }] })
  P.submitOrder(o.id); P.approveOrder(o.id)
  const itemId = P.orderDetail(o.id).order.items[0].id
  P.receiveOrder(o.id, [{ item_id: itemId, qty }])
  return P.orderDetail(o.id).order
}

test('发起召回：锁定批次、严重等级自动建投诉与事件、幂等重放', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')
  const m = matByName('公仔')
  const b = batchOf(sup.id, m.id)
  assert.ok(b, '需有供应商在库批次')
  const before = P.listMaterials().find(x => x.id === m.id).qty_on_hand
  const r1 = R.createRecall({
    supplier_id: sup.id, reason_type: 'quality', severity: 2,
    reason: '公仔缝线脱落', items: [{ material_id: m.id, batch_ids: [b.id] }],
    requestId: 'req-create-1'
  })
  assert.equal(r1.ok, true)
  assert.ok(r1.linkedComplaintIds.length >= 1, '严重召回应联动餐饮/问题投诉')
  assert.ok(events.some(e => e.type === 'recall'))
  // 隔离前批次仍在库，但召回明细已锁定
  assert.equal(db.prepare('SELECT status FROM inbound_batches WHERE id=?').get(b.id).status, 'in')
  // 幂等：重放返回同一单
  const r2 = R.createRecall({
    supplier_id: sup.id, severity: 2, reason: 'x',
    items: [{ material_id: m.id, batch_ids: [b.id] }], requestId: 'req-create-1'
  })
  assert.equal(r2.id, r1.id)
  // 同批次不能再发起第二个在途召回
  const r3 = R.createRecall({
    supplier_id: sup.id, severity: 1, reason: 'y',
    items: [{ material_id: m.id, batch_ids: [b.id] }], requestId: 'req-create-2'
  })
  assert.equal(r3.ok, false)
  assert.equal(r3.code, 'BATCH_HELD')
  void before
})

test('供应商应答与强制推进：异议不改状态，强制推进进入 acknowledged', () => {
  const sup = P.listSuppliers().find(s => s.category === '包材' || s.name.includes('包材')) || P.listSuppliers()[3]
  const m = matByName('一次性杯')
  const b = batchOf(sup.id, m.id)
  const r = R.createRecall({ supplier_id: sup.id, severity: 1, reason: '杯身破损', items: [{ material_id: m.id, batch_ids: [b.id] }] })
  assert.equal(R.acknowledgeRecall(r.id, { accept: false, note: '不认可' }).ok, true)
  assert.equal(R.recallDetail(r.id).status, 'issued', '异议后仍待园方处置')
  assert.equal(R.forceAcknowledge(r.id, { note: '核实属实' }).ok, true)
  assert.equal(R.recallDetail(r.id).status, 'acknowledged')
  // 已应答不能重复
  assert.equal(R.acknowledgeRecall(r.id, { accept: true }).ok, false)
})

test('批次隔离后 FEFO 停售，销售不再扣到问题批次', () => {
  const sup = P.listSuppliers().find(s => s.category === '饮品原料')
  const m = matByName('柠檬糖浆')
  const b = batchOf(sup.id, m.id)
  const vid = m.vendors[0].id
  const r = R.createRecall({ supplier_id: sup.id, severity: 2, reason: '糖浆变质', items: [{ material_id: m.id, batch_ids: [b.id] }] })
  R.quarantineRecall(r.id)
  const bb = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(b.id)
  assert.equal(bb.status, 'quarantined')
  assert.equal(bb.recall_id, r.id)
  // 销售可用量剔除隔离批次：再销售只动其他批次；现存仍含隔离实物（退货/销毁时才出园）
  const otherAvail = db.prepare(`SELECT COALESCE(SUM(qty_remain),0) q FROM inbound_batches
                                WHERE material_id=? AND status='in' AND qty_remain>0`).get(m.id).q
  assert.equal(onHand(m.id), Math.round((b.qty_remain + otherAvail) * 10) / 10, '现存仍含隔离实物')
  const cap = P.applyVendorSales(vid, 99999)
  assert.equal(Math.round(cap.sold), Math.round(otherAvail), '销量截断到非隔离批次可用量')
  const bb2 = db.prepare('SELECT qty_remain FROM inbound_batches WHERE id=?').get(b.id)
  assert.equal(bb2.qty_remain, b.qty_remain, '隔离批次不被销售扣减')
})

test('退在库货：未付采购单冲应付；已付批次登记供应商现金应收；结案销毁余货计损失', () => {
  // 未付账期供应商（食材 7 天）
  const sup = P.listSuppliers().find(s => s.category === '食材')
  const m = matByName('热狗肠')
  const o = freshPo(sup.id, m.id, 20, 4)
  const nb = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o.id, m.id)
  const r = R.createRecall({ supplier_id: sup.id, severity: 2, reason: '变质', items: [{ material_id: m.id, batch_ids: [nb.id] }] })
  R.acknowledgeRecall(r.id, { accept: true })
  R.quarantineRecall(r.id)
  // 隔离仅停售（可售量剔除），现存含隔离实物；退回供应商时实物出园才核减现存
  const stockBefore = onHand(m.id)
  const ret = R.returnRecallBatches(r.id)
  assert.equal(ret.ok, true)
  assert.equal(ret.amount, 80)
  assert.equal(ret.credit, 80, '未付采购单全额冲应付')
  assert.equal(ret.cashDue, 0)
  // 退货全额冲减采购单应付（应付=货款-退货冲抵）
  assert.equal(P.orderDetail(o.id).order.outstanding, 0, '20×4=80 全额退货冲抵，应付归零')
  assert.equal(onHand(m.id), Math.round((stockBefore - 20) * 10) / 10, '退货实物出园，现存核减 20')

  // 已付（货到即付供应商）批次：现金应收
  const sup0 = P.listSuppliers().find(s => s.category === '饮品原料')
  const m2 = matByName('一次性杯')
  const o2 = freshPo(sup0.id, m2.id, 30, 1)
  assert.equal(P.orderDetail(o2.id).order.status, 'settled')
  const nb2 = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o2.id, m2.id)
  const r2 = R.createRecall({ supplier_id: sup0.id, severity: 1, reason: '批次瑕疵', items: [{ material_id: m2.id, batch_ids: [nb2.id] }] })
  R.quarantineRecall(r2.id)
  // 只退 10 份：直接在批次层拆退（接口按整批退；这里退整批 30）
  const ret2 = R.returnRecallBatches(r2.id)
  assert.equal(ret2.ok, true)
  assert.equal(ret2.credit, 0)
  assert.equal(ret2.cashDue, 30, '已付款部分供应商现金应退')

  // 结案：无余货、无欠款
  const c = R.closeRecall(r.id, {})
  assert.equal(c.ok, true)
  assert.equal(R.recallDetail(r.id).status, 'closed')
})

test('结案销毁隔离余货：现存核减并按成本计园方损失，供应商评级下调', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')
  const m = matByName('益智玩具')
  const b = batchOf(sup.id, m.id)
  const rating0 = db.prepare('SELECT rating FROM suppliers WHERE id=?').get(sup.id).rating
  const r = R.createRecall({ supplier_id: sup.id, severity: 3, reason: '安全隐患', items: [{ material_id: m.id, batch_ids: [b.id] }] })
  R.forceAcknowledge(r.id, {})
  R.quarantineRecall(r.id)
  // 不退货直接结案：全部销毁，供应商未接受（强制推进）→ 暂停合作，评级 -2
  const cash0 = cash()
  const c = R.closeRecall(r.id, {})
  assert.equal(c.ok, true)
  assert.ok(c.destroyQty > 0)
  assert.equal(c.destroyCost, Math.round(c.destroyQty * b.unit_cost))
  assert.equal(cash(), cash0 - c.destroyCost)
  assert.equal(c.suspended, true)
  assert.equal(db.prepare('SELECT status FROM suppliers WHERE id=?').get(sup.id).status, 'suspended')
  assert.equal(db.prepare('SELECT rating FROM suppliers WHERE id=?').get(sup.id).rating, Math.max(1, rating0 - 2))
  // 恢复供应商供后续用例
  P.setSupplierStatus(sup.id, 'active')
  P.adjustSupplierRating(sup.id, 2)
})

test('已售召回退款（自营）：现金退货款+额外赔付，不回补库存；供应商赔付入账', () => {
  const sup = P.listSuppliers().find(s => s.category === '食材')
  const m = matByName('面包胚')
  const vid = m.vendors[0].id
  const v = db.prepare('SELECT * FROM vendors WHERE id=?').get(vid)
  // 先卖 3 份形成已售流出
  P.applyVendorSales(vid, 3)
  const remainBatches = db.prepare("SELECT * FROM inbound_batches WHERE material_id=? AND status='in' AND qty_remain>0 ORDER BY id LIMIT 1").get(m.id)
  const r = R.createRecall({
    supplier_id: sup.id, severity: 2, reason: '霉变', extra_comp: 5, handling_fee: 2,
    items: [{ material_id: m.id, batch_ids: [remainBatches.id] }]
  })
  const d = R.recallDetail(r.id)
  const sv = d.sold_vendors.find(x => x.vendorId === vid)
  assert.ok(sv, '应识别已售流向商铺')
  assert.ok(sv.soldQty >= 3)

  const cash0 = cash()
  const stock0 = onHand(m.id)
  const rr = R.refundRecallSold(r.id, { vendorId: vid, qty: 3 })
  assert.equal(rr.ok, true)
  assert.equal(rr.kind, 'self')
  assert.equal(rr.refundAmount, 3 * v.price)
  assert.equal(rr.compAmount, 15)
  assert.equal(rr.feeAmount, 6)
  assert.equal(cash(), cash0 - (3 * v.price + 15), '园方垫付货款+赔付')
  assert.equal(onHand(m.id), stock0, '召回退款不回补库存')

  // 超退拒绝
  assert.equal(R.refundRecallSold(r.id, { vendorId: vid, qty: 999 }).ok, false)

  // 应赔 = 退货货款 0 + 退款 + 赔付 + 处置费
  const d2 = R.recallDetail(r.id)
  const expectedBilled = 3 * v.price + 15 + 6
  assert.equal(d2.billed_amount, expectedBilled)
  assert.equal(d2.cash_due, expectedBilled)
  // 供应商赔付（分次）
  const cash1 = cash()
  const pay1 = R.payRecall(r.id, 10)
  assert.equal(pay1.ok, true)
  assert.equal(cash(), cash1 + 10)
  assert.equal(R.payRecall(r.id, expectedBilled).ok, false, '超额赔付拒绝')
  assert.equal(R.payRecall(r.id, expectedBilled - 10).ok, true)
  assert.equal(R.recallDetail(r.id).cash_unpaid, 0)
})

test('联营已售召回退款：分账红冲不回库存不冲 COGS，批次成本/处置费/赔付随结算账单付商户', async () => {
  const sup = P.listSuppliers().find(s => s.category === '食材')
  // 新联营商户：申请 → 签约（免建店费，自动挂物资）
  const ap = PT.applyPartner({
    mode: 'new', name: '召回测试联营铺', contact: '钱老板', phone: '139-0000-0001',
    type: '餐饮', zone_id: 1, commission_rate: 0.2, settle_period_days: 7, deposit: 0
  })
  assert.equal(ap.ok, true)
  const ap2 = PT.approveApplication(ap.id, { deposit: 0 })
  assert.equal(ap2.ok, true)
  const vid = ap2.vendorId
  // 挂一个有库存的食材物资并联营销售 4 份（先调价格）
  const m = matByName('爆米花原料(玉米粒+糖)'.includes('玉米粒') ? '爆米花' : '爆米花')
  db.prepare('UPDATE vendors SET price=28 WHERE id=?').run(vid)
  P.setVendorMaterials(vid, [m.id])
  db.prepare("UPDATE materials SET std_cost=6 WHERE id=?").run(m.id)
  // 确保该供应商有在库批次
  let b = db.prepare("SELECT * FROM inbound_batches WHERE supplier_id=? AND material_id=? AND status='in' AND qty_remain>0 ORDER BY id LIMIT 1").get(sup.id, m.id)
  if (!b) {
    const o = freshPo(sup.id, m.id, 100, 6)
    b = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o.id, m.id)
  }
  const sale = PT.recordSale(vid, { qty: 4, gross: 112, bill: 112, source: 'organic', note: '联营售出' })
  P.applyVendorSales(vid, 4, { partner: true })
  assert.ok(sale.saleId)

  const r = R.createRecall({
    supplier_id: sup.id, severity: 3, reason: '食品安全', extra_comp: 10, handling_fee: 3,
    items: [{ material_id: m.id, batch_ids: [b.id] }]
  })
  R.forceAcknowledge(r.id, {})
  const rr = R.refundRecallSold(r.id, { vendorId: vid, qty: 4 })
  assert.equal(rr.ok, true)
  assert.equal(rr.kind, 'partner')
  assert.equal(rr.refundAmount, 112)
  assert.equal(rr.compAmount, 40)
  assert.equal(rr.feeAmount, 12)
  assert.ok(rr.cogsAmount > 0, '联营批次成本应核定')

  // 召回红冲行存在且 recall_id 正确，partnerCogs 不扣减召回部分（货不回库）
  const rows = db.prepare("SELECT * FROM partner_sales WHERE recall_id=? AND kind='return'").all(r.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].qty, -4)
  const cogsNow = P.partnerCogs(vid, 1, 999).cogs
  assert.ok(cogsNow >= 24, '正常销售 FEFO 成本仍计入，召回红冲不冲 COGS')

  // 出结算账单：应付含召回承担（批次成本+处置费+赔付）；召回红冲本身不进 FEFO COGS 汇总（仅按正常销售计 24）
  const cid = PT.activeContract(vid).id
  const issue = PT.issueSettlement(cid, {})
  assert.equal(issue.ok, true)
  const bill = PT.settlementDetail(issue.id).settlement
  assert.equal(bill.recall_comp, rr.cogsAmount + 40 + 12, '召回承担=批次成本+处置费+额外赔付=76')
  // 召回红冲不冲 COGS（货不回库）：区间 COGS 仅含正常销售 4 份 × ¥6 = 24
  assert.equal(bill.cogs, 24, '召回红冲不进 FEFO 成本汇总')
  assert.equal(bill.merchant_share, 0, '正向分账 90 被召回红冲 -90 净额冲平')
  // 应付 = 0（净分账） - 24（正常 COGS 扣收） + 76（召回承担） = 52
  assert.equal(bill.payable, 52)
  const cash0 = cash()
  assert.equal(PT.paySettlement(issue.id).ok, true)
  assert.equal(cash(), cash0 - bill.payable)
  assert.equal(db.prepare('SELECT settlement_id FROM recall_refunds WHERE id=?').get(rr.id).settlement_id, issue.id)
  assert.ok(JSON.stringify(finLogs).includes('召回承担'))

  // 清理：终止合同不影响其他用例
  PT.terminateContract(cid, { reason: '测试结束' })
})

test('供应商应赔现金分次赔付、超额拒绝；结案未赔可核销计园方损失', () => {
  const sup = P.listSuppliers().find(s => s.category === '饮品原料')
  const m = matByName('一次性杯')
  const vid = m.vendors[0]?.id
  // 新开一笔货到即付采购，保证有专属在库批次（前序用例可能已消耗期初库存）
  const o = freshPo(sup.id, m.id, 40, 1)
  assert.equal(P.orderDetail(o.id).order.status, 'settled')
  const b = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o.id, m.id)
  P.applyVendorSales(vid, 2)
  const r = R.createRecall({ supplier_id: sup.id, severity: 2, reason: '瑕疵', items: [{ material_id: m.id, batch_ids: [b.id] }] })
  R.quarantineRecall(r.id)
  R.returnRecallBatches(r.id)  // 已付（货到即付）→ 现金应收
  R.refundRecallSold(r.id, { vendorId: vid, qty: 2 })
  const due = R.recallDetail(r.id).cash_unpaid
  assert.ok(due > 0)
  const c = R.closeRecall(r.id, { writeOff: true })
  assert.equal(c.ok, true)
  assert.equal(c.unpaid, due, '未赔现金核销')
  assert.equal(c.parkLoss, due + c.destroyCost)
  // 关联投诉结案闭环
  const linked = R.recallDetail(r.id).linked_complaints
  for (const cid of linked) assert.ok(closedComplaints.includes(cid), '关联投诉应随召回结案闭环')
})

test('撤销召回：未隔离未退款前可撤销；隔离后不可撤销', () => {
  const sup = P.listSuppliers().find(s => s.category === '食材')
  const m = matByName('爆米花')
  // 专属批次，避免被前序用例隔离/耗尽
  const o = freshPo(sup.id, m.id, 30, 6)
  const b = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o.id, m.id)
  const r = R.createRecall({ supplier_id: sup.id, severity: 1, reason: '疑似误报', items: [{ material_id: m.id, batch_ids: [b.id] }] })
  assert.equal(R.cancelRecall(r.id, { note: '误报' }).ok, true)
  assert.equal(R.recallDetail(r.id).status, 'cancelled')
  assert.equal(db.prepare('SELECT status FROM inbound_batches WHERE id=?').get(b.id).status, 'in', '撤销后批次恢复可售')

  const o2 = freshPo(sup.id, m.id, 20, 6)
  const b2 = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o2.id, m.id)
  const r2 = R.createRecall({ supplier_id: sup.id, severity: 1, reason: 'x', items: [{ material_id: m.id, batch_ids: [b2.id] }] })
  R.quarantineRecall(r2.id)
  assert.equal(R.cancelRecall(r2.id).ok, false, '已隔离不可撤销')
})

test('超时未应答：引擎推进生成事件通知（去重）', () => {
  const sup = P.listSuppliers().find(s => s.category === '文创百货')
  const m = matByName('纪念 T 恤') || matByName('T 恤')
  const o = freshPo(sup.id, m.id, 10, m.std_cost || 22)
  const b = db.prepare("SELECT * FROM inbound_batches WHERE order_id=? AND material_id=? ORDER BY id DESC LIMIT 1").get(o.id, m.id)
  const events0 = events.length
  const r = R.createRecall({ supplier_id: sup.id, severity: 2, reason: 'x', items: [{ material_id: m.id, batch_ids: [b.id] }] })
  setSetting('tick', 100 + R.RECALL_CONST.ACK_SLA_TICKS)
  R.processRecallTick()
  assert.ok(events.length > events0, '超时应推送事件')
  const n1 = events.length
  R.processRecallTick()
  assert.equal(events.length, n1, '同一召回超时通知只发一次')
  void r
})

test('统计口径：召回数量与金额一致', () => {
  const s = R.recallStats()
  assert.ok(s.open >= 0)
  assert.ok(s.billed >= s.supplierPaid)
  assert.ok(s.qty.returned >= 0)
})
