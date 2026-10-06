import db, { getSetting, setSetting, tx } from './db.js'

// 供应商批次召回模块（供应商 · 园方 · 联营商户 三方协同）：
//   发起召回（食安/质检/投诉联动）→ 供应商应答（接受/异议；超时事件通知，园方可强制推进）
//   → 在库批次隔离（FEFO 自动停售，库存可用量即时收紧）→ 已售商品游客退款（自营现金退/联营分账红冲）
//   → 退回供应商（未付货款冲应付、已付货款登记现金应收）→ 供应商赔付（现金入账）→ 结案
// 资金口径：
//   · 退在库货：未付部分冲采购应付（非现金）；已付部分供应商现金赔付
//   · 退已售货：园方先垫付游客「货款+额外赔付」；联营商户的批次成本/处置费/额外赔付随结算账单支付（供应商资金来源）
//   · 供应商应赔 = 退货货款 + 游客退款 + 额外赔付 + 处置费；现金不足供应商可分次赔付，结案未赔部分计园方损失
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const round1 = v => Math.round(v * 10) / 10

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  // 采购库存联动（procurement.js）
  quarantineRecallBatch: null, recallReturnBatch: null, recallDestroyBatch: null,
  releaseRecallBatch: null, recallOutflow: null,
  purchaseOutstanding: null, recordRecallReturnLine: null,
  adjustSupplierRating: null, setSupplierStatus: null,
  // 联营联动（partners.js）
  activePartnerContract: null, recordRecallChargeback: null,
  // 投诉联动 / 事件通知（index.js 注入）
  createComplaint: null, closeComplaintLinked: null, emitEvent: null
}
export function initRecallContext(deps) { Object.assign(ctx, deps) }

export class RecallError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra) }
}

export const RECALL_CONST = {
  SEVERITY: { 1: '一般', 2: '严重', 3: '紧急' },
  REASON: { quality: '质量缺陷', safety: '食品安全', label: '标签不符', expiry: '变质过期', other: '其他' },
  ACK_SLA_TICKS: 6,          // 供应商应答时限（游戏小时）
  FIN_RETURN: '召回退货款',
  FIN_REFUND: '召回退款',
  FIN_COMP: '召回赔付',
  FIN_HANDLING: '召回处置费',
  FIN_LOSS: '召回损失'
}

const ISSUED = ['issued', 'forced']
const ACKED = ['acknowledged', 'quarantining', 'refunding']

function stampCode(table, idCol, id, prefix) {
  db.prepare(`UPDATE ${table} SET code=? WHERE ${idCol}=?`).run(prefix + String(id).padStart(4, '0'), id)
}
function logRecall(recallId, action, note = '', { actor = 'operations', staffId = null } = {}) {
  db.prepare('INSERT INTO recall_logs(recall_id,tick,day,hour,action,actor_role,staff_id,note) VALUES(?,?,?,?,?,?,?,?)')
    .run(recallId, ctx.tick(), ctx.day(), ctx.hour(), action, actor, staffId, note)
}
function getRecall(id) {
  return db.prepare('SELECT * FROM recalls WHERE id=?').get(num(id))
}
function getMaterial(id) {
  return db.prepare('SELECT * FROM materials WHERE id=?').get(num(id))
}
function getSupplier(id) {
  return db.prepare('SELECT * FROM suppliers WHERE id=?').get(num(id))
}

// 幂等：写操作携带请求号，重放返回首次结果
function idemRun(scope, requestId, fn) {
  const key = String(requestId || '').slice(0, 80)
  if (!key) return fn()
  const exist = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (exist) { try { return { ...JSON.parse(exist.response), replay: true } } catch { /* 快照损坏则重放 */ } }
  const r = fn()
  try {
    db.prepare('INSERT INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(r), ctx.tick(), ctx.day())
  } catch { /* 并发唯一索引冲突时首次结果已落，忽略 */ }
  return r
}

function emitEvent(kind, title, desc, impact = -1) {
  if (ctx.emitEvent) { try { ctx.emitEvent(kind, title, desc, impact); return } catch { /* index 未注入时落库 */ } }
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(ctx.tick(), ctx.day(), kind, title, desc, impact, 'active')
}

// ---------------- 发起召回 ----------------
// payload: { supplier_id, reason_type, severity, title, reason, source, complaint_id,
//            items: [{ material_id, batch_ids?:[], affected_qty? }], extra_comp, handling_fee, staff_id, requestId }
// 指定 batch_ids 精确锁定批次；否则自动按 FEFO 取该供应商在库未隔离批次（建议量，待隔离动作实际生效）
export function createRecall(payload = {}) {
  const run = () => {
    const supplier = getSupplier(num(payload.supplier_id))
    if (!supplier) return { ok: false, code: 'BAD_ARG', msg: '请选择召回供应商' }
    const sev = Math.max(1, Math.min(3, Math.round(num(payload.severity, 2))))
    const reasonType = RECALL_CONST.REASON[payload.reason_type] ? payload.reason_type : 'quality'
    const title = String(payload.title || '').trim() || `${supplier.name}批次召回（${RECALL_CONST.REASON[reasonType]}）`
    const reason = String(payload.reason || '').trim()
    if (!reason && reasonType === 'other') return { ok: false, code: 'BAD_ARG', msg: '请填写召回原因说明' }
    const extraComp = Math.max(0, Math.round(num(payload.extra_comp)))
    const handlingFee = Math.max(0, Math.round(num(payload.handling_fee)))

    const lines = []
    for (const it of payload.items || []) {
      const m = getMaterial(num(it.material_id))
      if (!m) return { ok: false, code: 'BAD_ARG', msg: `物资 #${it.material_id} 不存在` }
      let batchIds = (it.batch_ids || []).map(num).filter(Boolean)
      if (batchIds.length) {
        for (const bid of batchIds) {
          const b = db.prepare("SELECT * FROM inbound_batches WHERE id=? AND status='in' AND qty_remain>0").get(bid)
          if (!b) return { ok: false, code: 'BAD_ARG', msg: `批次 RK${String(bid).padStart(4, '0')} 不可召回（已耗尽/隔离/不存在）` }
          if (b.material_id !== m.id) return { ok: false, code: 'BAD_ARG', msg: '批次与物资不一致' }
        }
      }
      let affected = round1(num(it.affected_qty))
      if (!batchIds.length && affected <= 0) affected = 0   // 自动召回：隔离时按 FEFO 补选批次并回填涉及量
      if (batchIds.length) {
        affected = round1(batchIds.reduce((s, bid) =>
          s + num(db.prepare('SELECT qty_remain q FROM inbound_batches WHERE id=?').get(bid)?.q), 0))
      }
      lines.push({ materialId: m.id, batchIds, affected })
    }
    if (!lines.length) return { ok: false, code: 'BAD_ARG', msg: '至少添加一项召回事宜物资' }

    // 同一批次不能同时被两个在途召回锁定（幂等重放在 idemRun 层直接返回首次结果，不会走到这里）
    for (const l of lines) {
      for (const bid of l.batchIds) {
        const dup = db.prepare(`SELECT r.id FROM recall_batches rb JOIN recalls r ON r.id=rb.recall_id
                               WHERE rb.batch_id=? AND rb.status IN ('pending','quarantined','partial')`).get(bid)
        if (dup) return { ok: false, code: 'BATCH_HELD', msg: `批次已被召回单 ZH${String(dup.id).padStart(4, '0')} 锁定` }
      }
    }

    return tx(() => {
    const affectedQty = round1(lines.reduce((s, l) => s + l.affected, 0))
    // 已售流向：指定批次精确按批次流水统计；未指定批次按供应商+物资+最早收货日统计
    const matIds = lines.map(l => l.materialId)
    const allBatchIds = lines.flatMap(l => l.batchIds)
    let dayFrom = 0
    for (const bid of allBatchIds) {
      const d = num(db.prepare('SELECT receive_day d FROM inbound_batches WHERE id=?').get(bid)?.d)
      if (!dayFrom || d < dayFrom) dayFrom = d
    }
    const outflow = ctx.recallOutflow
      ? ctx.recallOutflow(matIds, allBatchIds.length
          ? { batchIds: allBatchIds, dayFrom, dayTo: ctx.day() }
          : { supplierId: supplier.id, dayFrom, dayTo: ctx.day() })
      : new Map()
    const soldQty = round1([...outflow.values()].reduce((s, e) => s + e.qty, 0))

    const r = db.prepare(`INSERT INTO recalls
      (code,supplier_id,status,reason_type,severity,title,reason,source,complaint_id,linked_complaint_ids,
       extra_comp,handling_fee,staff_id,affected_qty,sold_qty,create_tick,create_day)
      VALUES('',?, 'issued',?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`)
      .run(supplier.id, reasonType, sev, title, reason,
           payload.source === 'complaint' ? 'complaint' : payload.source === 'supplier' ? 'supplier' : 'manual',
           num(payload.complaint_id) || null, '[]', extraComp, handlingFee,
           num(payload.staff_id) || null, affectedQty, soldQty, ctx.tick(), ctx.day())
    const id = Number(r.lastInsertRowid)
    stampCode('recalls', 'id', id, 'ZH')

    const ii = db.prepare(`INSERT INTO recall_items(recall_id,material_id,affected_qty,sold_qty) VALUES(?,?,?,?)`)
    const bi = db.prepare(`INSERT INTO recall_batches(recall_id,item_id,batch_id,qty,status) VALUES(?,?,?,?,'pending')`)
    const vendorsOut = []
    for (const l of lines) {
      const ir = ii.run(id, l.materialId, l.affected, round1([...outflow.values()].reduce((s, e) => s + (e.byMaterial.get(l.materialId) || 0), 0)))
      const itemId = Number(ir.lastInsertRowid)
      for (const bid of l.batchIds) {
        const q = num(db.prepare('SELECT qty_remain q FROM inbound_batches WHERE id=?').get(bid).q)
        bi.run(id, itemId, bid, q)
      }
      for (const e of outflow.values()) {
        const q = e.byMaterial.get(l.materialId)
        if (q) vendorsOut.push({ vendorId: e.vendorId, materialId: l.materialId, qty: round1(q) })
      }
    }

    logRecall(id, 'create', `发起供应商批次召回：涉及 ${lines.length} 项物资 / 在库 ${affectedQty} 份 / 已售流向商铺约 ${soldQty} 份；供应商应答时限 ${RECALL_CONST.ACK_SLA_TICKS} 小时`,
      { staffId: num(payload.staff_id) || null })

    // 食安/紧急召回：自动生成餐饮质量投诉并联动处置（供应商/园方/投诉闭环）
    let linked = []
    if (sev >= 2) {
      const vids = [...new Set(vendorsOut.map(x => x.vendorId))]
      const targetVendor = vids.length === 1 ? vids[0] : (vids[0] || null)
      if (ctx.createComplaint) {
        const c = ctx.createComplaint({
          category: 'food',
          severity: sev,
          title: `供应商批次召回 · ${supplier.name}`,
          content: `${title}：${reason || RECALL_CONST.REASON[reasonType]}。园方已启动批次召回，涉及商品统一退款与赔付。`,
          target: targetVendor ? { type: 'vendor', id: targetVendor, name: db.prepare('SELECT name FROM vendors WHERE id=?').get(targetVendor)?.name || '' } : { type: '', id: null, name: '' },
          source: 'manual'
        })
        if (c?.id) linked.push(c.id)
      }
      if (num(payload.complaint_id)) linked.push(num(payload.complaint_id))
    }
    linked = [...new Set(linked)]
    if (linked.length) db.prepare('UPDATE recalls SET linked_complaint_ids=? WHERE id=?').run(JSON.stringify(linked), id)

    emitEvent('recall', `🔁 供应商批次召回 ${'ZH' + String(id).padStart(4, '0')}：${title}`,
      `供应商「${supplier.name}」批次因${RECALL_CONST.REASON[reasonType]}被召回：在库 ${affectedQty} 份立即隔离停售，已售约 ${soldQty} 份需通知商铺与游客退款赔付；请供应商于 ${RECALL_CONST.ACK_SLA_TICKS} 小时内应答。`, sev >= 3 ? -2 : -1)
    return { ok: true, id, code: 'ZH' + String(id).padStart(4, '0'), soldQty, affectedQty, linkedComplaintIds: linked }
    })
  }

  try {
    return idemRun('recall_create', payload.requestId, run)
  } catch (e) {
    return { ok: false, code: e.code || 'TX_FAILED', msg: e.message || '召回发起失败' }
  }
}

// ---------------- 供应商应答 ----------------
export function acknowledgeRecall(id, { accept = true, note = '', staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (r.status !== 'issued') return { ok: false, code: 'BAD_STATE', msg: '召回单已应答，不能重复应答' }
    return tx(() => {
      if (accept) {
        db.prepare("UPDATE recalls SET status='acknowledged',supplier_accepted=1,supplier_response=?,response_tick=?,response_day=?,ack_tick=? WHERE id=?")
          .run(String(note || '供应商接受召回方案'), ctx.tick(), ctx.day(), ctx.tick(), r.id)
        logRecall(r.id, 'acknowledge', `供应商接受召回：${note || '同意按召回方案隔离、退货与赔付'}`, { actor: 'supplier', staffId })
      } else {
        db.prepare("UPDATE recalls SET supplier_response=?,response_tick=?,response_day=? WHERE id=?")
          .run('供应商异议：' + String(note || '对召回原因/范围有异议'), ctx.tick(), ctx.day(), r.id)
        logRecall(r.id, 'dispute', `供应商提出异议：${note || '对召回原因/范围有异议'}（园方可核实后强制推进）`, { actor: 'supplier', staffId })
        emitEvent('recall', `⚠️ 供应商对召回 ${r.code} 提出异议`,
          `供应商「${getSupplier(r.supplier_id)?.name}」对召回 ${r.code} 提出异议：${note || '原因/范围待核实'}。园方可核实后强制推进。`, -1)
      }
      return { ok: true, accepted: !!accept }
    })
  }
  try { return idemRun('recall_ack', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// 园方强制推进（供应商异议或超时不应答）
export function forceAcknowledge(id, { note = '', staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (!['issued', 'forced'].includes(r.status)) return { ok: false, code: 'BAD_STATE', msg: '当前状态不可强制推进' }
    return tx(() => {
      db.prepare("UPDATE recalls SET status='acknowledged',supplier_accepted=0,ack_tick=?,supplier_response=COALESCE(NULLIF(supplier_response,''),?) WHERE id=?")
        .run(ctx.tick(), `园方核实后强制推进：${note || '供应商超时未应答/异议不成立'}`, r.id)
      logRecall(r.id, 'force', `园方强制推进召回：${note || '供应商超时未应答，按食安预案先行处置'}`, { staffId })
      emitEvent('recall', `🚩 召回 ${r.code} 已由园方强制推进`,
        `供应商「${getSupplier(r.supplier_id)?.name}」未按时接受召回，园方按食品安全预案强制隔离并推进退款退货，赔付款项后续向供应商追偿。`, -1)
      return { ok: true }
    })
  }
  try { return idemRun('recall_force', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// ---------------- 在库批次隔离 ----------------
// 隔离整批（锁定的 recall_batches）；也可在发起时未指定批次的情况下，自动挑选该供应商在库批次
export function quarantineRecall(id, { batchIds = null, staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (!ACKED.includes(r.status) && !['issued', 'forced'].includes(r.status)) {
      return { ok: false, code: 'BAD_STATE', msg: '召回已结案/撤销，不能隔离' }
    }
    return tx(() => {
      // 紧急情况下允许「先隔离后应答」：隔离动作同时把状态推进到 quarantining
      let rows = db.prepare("SELECT * FROM recall_batches WHERE recall_id=? AND status='pending'").all(r.id)
      if (batchIds) {
        const set = new Set(batchIds.map(num))
        rows = rows.filter(x => set.has(x.batch_id))
      }
      let qty = 0
      for (const rb of rows) {
        const b = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(rb.batch_id)
        if (!b || b.status !== 'in' || b.qty_remain <= 0) continue
        const res = ctx.quarantineRecallBatch(b.id, b.qty_remain, r.id)
        qty = round1(qty + res.qty)
        db.prepare("UPDATE recall_batches SET quarantined_qty=?,status='quarantined',update_tick=? WHERE id=?")
          .run(res.qty, ctx.tick(), rb.id)
      }
      // 发起时未指定批次：自动按 FEFO 补选该供应商该物资的在库批次
      const items = db.prepare('SELECT * FROM recall_items WHERE recall_id=?').all(r.id)
      const autoAdded = []
      for (const it of items) {
        const pending = db.prepare("SELECT COALESCE(SUM(qty),0) q FROM recall_batches WHERE item_id=? AND status IN ('pending','quarantined','partial')").get(it.id).q
        if (pending > 0) continue
        const cand = db.prepare(`SELECT * FROM inbound_batches
                                WHERE material_id=? AND IFNULL(supplier_id,0)=? AND status='in' AND qty_remain>0
                                ORDER BY CASE WHEN expire_day=0 THEN 1 ELSE 0 END, expire_day, id LIMIT 3`).all(it.material_id, r.supplier_id)
        for (const b of cand) {
          if (db.prepare("SELECT 1 FROM recall_batches WHERE batch_id=? AND status IN ('pending','quarantined','partial')").get(b.id)) continue
          const res = ctx.quarantineRecallBatch(b.id, b.qty_remain, r.id)
          db.prepare("INSERT INTO recall_batches(recall_id,item_id,batch_id,qty,quarantined_qty,status,update_tick) VALUES(?,?,?,?,?, 'quarantined',?)")
            .run(r.id, it.id, b.id, res.qty, res.qty, ctx.tick())
          db.prepare('UPDATE recall_items SET affected_qty=affected_qty+? WHERE id=?').run(res.qty, it.id)
          qty = round1(qty + res.qty)
          autoAdded.push(res.qty)
        }
      }
      if (qty <= 0 && !autoAdded.length) return { ok: false, code: 'NOTHING_TO_DO', msg: '没有可隔离的在库批次' }
      // 自动补选批次后重算涉及总量与已售流向（自动召回发起时 affected=0）
      const totalAffected = round1(num(db.prepare('SELECT COALESCE(SUM(affected_qty),0) q FROM recall_items WHERE recall_id=?').get(r.id).q))
      const matIds = items.map(x => x.material_id)
      const allBatchIds = db.prepare('SELECT batch_id FROM recall_batches WHERE recall_id=?').all(r.id).map(x => x.batch_id)
      let soldQty = 0
      if (ctx.recallOutflow && allBatchIds.length) {
        const of = ctx.recallOutflow(matIds, { batchIds: allBatchIds, dayFrom: 0, dayTo: ctx.day() })
        soldQty = round1([...of.values()].reduce((s, e) => s + e.qty, 0))
      }
      db.prepare('UPDATE recalls SET quarantined_qty=quarantined_qty+?, affected_qty=?, sold_qty=?, status=? WHERE id=?')
        .run(qty, totalAffected, soldQty, 'quarantining', r.id)
      logRecall(r.id, 'quarantine', `隔离问题批次 ${qty} 份（即刻停售，FEFO 销售自动跳过）`, { staffId })
      return { ok: true, qty }
    })
  }
  try { return idemRun('recall_quarantine', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// ---------------- 退回供应商 ----------------
// 隔离批次整批退货（部分剩余留待销毁）；冲采购应付（非现金）或登记供应商现金应收
export function returnRecallBatches(id, { batchIds = null, staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (!['quarantining', 'refunding', 'acknowledged'].includes(r.status)) {
      return { ok: false, code: 'BAD_STATE', msg: '需先隔离批次后再退回供应商' }
    }
    return tx(() => {
      let rows = db.prepare("SELECT * FROM recall_batches WHERE recall_id=? AND status='quarantined'").all(r.id)
      if (batchIds) {
        const set = new Set(batchIds.map(num))
        rows = rows.filter(x => set.has(x.batch_id))
      }
      if (!rows.length) return { ok: false, code: 'NOTHING_TO_DO', msg: '没有已隔离待退回的批次' }
      let qty = 0, amount = 0, credit = 0, cashDue = 0
      for (const rb of rows) {
        const b = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(rb.batch_id)
        if (!b || b.qty_remain <= 0) continue
        const res = ctx.recallReturnBatch(b.id, b.qty_remain, r.id)
        qty = round1(qty + res.qty)
        const lineAmount = Math.round(res.qty * res.unitCost)
        amount += lineAmount
        // 货款：先冲该采购单未付应付；超出部分为供应商现金应退（期初批次 order_id 为空 → 全部现金应收）
        const out = res.orderId ? (ctx.purchaseOutstanding ? ctx.purchaseOutstanding(res.orderId) : 0) : 0
        const lineCredit = Math.min(out, lineAmount)
        const lineCash = lineAmount - lineCredit
        credit += lineCredit
        cashDue += lineCash
        ctx.recordRecallReturnLine?.({
          orderId: res.orderId, batchId: b.id, materialId: b.material_id,
          qty: res.qty, amount: lineAmount, recallId: r.id
        })
        db.prepare("UPDATE recall_batches SET returned_qty=returned_qty+?,status='returned',update_tick=? WHERE id=?")
          .run(res.qty, ctx.tick(), rb.id)
        db.prepare('UPDATE recall_items SET returned_qty=returned_qty+? WHERE id=?').run(res.qty, rb.item_id)
        if (lineCredit > 0) ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_RETURN, 0, `召回 ${r.code} 批次 RK${String(b.id).padStart(4, '0')} 退供应商，冲减采购应付 ¥${lineCredit}`)
      }
      db.prepare('UPDATE recalls SET returned_qty=returned_qty+?, billed_amount=billed_amount+?, credit_amount=credit_amount+?, cash_due=cash_due+? WHERE id=?')
        .run(qty, amount, credit, cashDue, r.id)
      logRecall(r.id, 'return', `退回供应商 ${qty} 份，货款 ¥${amount}（冲应付 ¥${credit}，供应商现金应退 ¥${cashDue}）`, { staffId })
      return { ok: true, qty, amount, credit, cashDue }
    })
  }
  try { return idemRun('recall_return', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// 应赔金额累计（退货/退款动作中调用，同事务）：credit=冲应付（非现金），其余计入现金应收
function applyBilling(recallId, { returnAmount = 0, returnCredit = 0, refundAmount = 0, compAmount = 0, feeAmount = 0 } = {}) {
  const billed = Math.round(returnAmount + refundAmount + compAmount + feeAmount)
  const credit = Math.round(returnCredit)
  db.prepare('UPDATE recalls SET billed_amount=?, credit_amount=?, cash_due=? WHERE id=?')
    .run(billed, credit, Math.max(0, billed - credit), recallId)
}

// ---------------- 已售商品召回退款（园方 + 联营商户协同） ----------------
// 按商铺核定：自营现金直退（货款+额外赔付）；联营园方垫付游客并写分账红冲，
// 批次成本/处置费/额外赔付登记 recall_refunds 随结算账单支付给商户（供应商资金来源）
export function refundRecallSold(id, { vendorId, qty, materialId = null, staffId = null, note = '', requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (!ACKED.includes(r.status) && !['issued', 'forced', 'quarantining'].includes(r.status)) {
      return { ok: false, code: 'BAD_STATE', msg: '召回已结案/撤销' }
    }
    const vendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(num(vendorId))
    if (!vendor) return { ok: false, code: 'BAD_ARG', msg: '商铺不存在' }
    const q = Math.max(1, Math.round(num(qty)))

    const soldAgg = soldByVendor(r.id)
    const agg = soldAgg.find(x => x.vendorId === vendor.id)
    if (!agg) return { ok: false, code: 'NO_SOLD', msg: '该召回批次未流向该商铺，无已售可退' }
    // 指定物资时按物资限额校验；未指定时按该商铺全部召回物资总量
    const mid = num(materialId) || null
    const soldMat = mid ? num(agg.materials.find(x => x.materialId === mid)?.qty || 0) : num(agg.soldQty)
    if (!soldMat) return { ok: false, code: 'NO_SOLD', msg: '该召回批次未流向该商铺，无已售可退' }
    const refunded = num(db.prepare('SELECT COALESCE(SUM(qty),0) q FROM recall_refunds WHERE recall_id=? AND vendor_id=? AND (?=0 OR material_id=?)')
      .get(r.id, vendor.id, mid, mid).q)
    if (refunded + q > soldMat + 0.0001) {
      return { ok: false, code: 'OVER_REFUND', msg: `退款数量超出该商铺已售召回量（已退 ${refunded}/${soldMat}）` }
    }
    const useMaterialId = mid || agg.materials[0]?.materialId || null

    return tx(() => {
      const unitRefund = Math.max(0, Math.round(vendor.price))
      const refundAmount = Math.round(q * unitRefund)
      const compAmount = Math.round(q * r.extra_comp)
      const feeAmount = Math.round(q * r.handling_fee)
      const contract = ctx.activePartnerContract ? ctx.activePartnerContract(vendor.id) : null
      const kind = contract ? 'partner' : 'self'

      // 联营：按召回批次单位成本核定退还商户的批次成本（供应商承担，随结算账单支付）；
      // 无锁定批次（自动召回）时回退该物资当前在库批次的移动平均成本
      let cogsAmount = 0
      if (contract) {
        let unitCost = avgRecalledUnitCost(r.id, useMaterialId)
        if (unitCost <= 0) {
          const cr = db.prepare(`SELECT COALESCE(SUM(qty_remain*unit_cost),0) c, COALESCE(SUM(qty_remain),0) q
                                 FROM inbound_batches WHERE material_id=? AND status IN ('in','quarantined','returned') AND qty_remain>0`).get(useMaterialId)
          unitCost = num(cr.q) > 0 ? Math.round((num(cr.c) / num(cr.q)) * 100) / 100 : num(getMaterial(useMaterialId)?.std_cost)
        }
        cogsAmount = Math.round(q * unitCost)
      }

      const rid = db.prepare(`INSERT INTO recall_refunds
        (code,recall_id,vendor_id,contract_id,material_id,kind,qty,unit_refund,refund_amount,comp_amount,fee_amount,cogs_amount,day,tick,note)
        VALUES('',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.id, vendor.id, contract?.id || null, useMaterialId,
             kind, q, unitRefund, refundAmount, compAmount, feeAmount, cogsAmount, ctx.day(), ctx.tick(),
             note || `召回 ${r.code} 已售商品退款`)
      const rrid = Number(rid.lastInsertRowid)
      stampCode('recall_refunds', 'id', rrid, 'ZT')

      // 园方垫付游客：货款 + 额外赔付（现金）
      const cashOut = refundAmount + compAmount
      setSetting('cash', Math.round(ctx.cash() - cashOut))
      ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_REFUND, -refundAmount, `召回 ${r.code}「${vendor.name}」已售商品 ${q} 份退款`)
      if (compAmount > 0) ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_COMP, -compAmount, `召回 ${r.code}「${vendor.name}」游客召回赔付（¥${r.extra_comp}/份，供应商承担）`)
      if (feeAmount > 0) ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_HANDLING, 0, `召回 ${r.code}「${vendor.name}」处置费 ¥${feeAmount}（${kind === 'partner' ? '联营商户随结算账单收取' : '园方收取'}，供应商承担）`)

      // 联营：分账红冲（不回补库存、不冲 FEFO 成本）
      if (contract) {
        const cr = ctx.recordRecallChargeback(vendor.id, { qty: q, refund: refundAmount, recallId: r.id, note: `召回 ${r.code} 已售退款红冲` })
        if (!cr?.ok) throw new RecallError('PARTNER_RECALL_FAILED', cr?.msg || '联营分账红冲失败')
      }

      // 回写明细/主单
      if (mid) {
        db.prepare('UPDATE recall_items SET refunded_qty=refunded_qty+? WHERE recall_id=? AND material_id=?')
          .run(q, r.id, mid)
      } else {
        // 未指定物资：本次退款归属该商铺主要召回物资（sold_vendors 当前为单物资场景）
        if (useMaterialId) db.prepare('UPDATE recall_items SET refunded_qty=refunded_qty+? WHERE recall_id=? AND material_id=?')
          .run(q, r.id, useMaterialId)
      }
      db.prepare('UPDATE recalls SET refunded_qty=refunded_qty+?,customer_refund_total=customer_refund_total+?,customer_comp_total=customer_comp_total+?,status=? WHERE id=?')
        .run(q, refundAmount, compAmount, 'refunding', r.id)
      db.prepare('UPDATE recalls SET billed_amount=billed_amount+?, cash_due=cash_due+? WHERE id=?')
        .run(refundAmount + compAmount + feeAmount, refundAmount + compAmount + feeAmount, r.id)
      logRecall(r.id, 'refund_sold', `${kind === 'partner' ? '联营' : '自营'}商铺「${vendor.name}」召回退款 ${q} 份：货款 ¥${refundAmount}${compAmount ? ` +赔付 ¥${compAmount}` : ''}${feeAmount ? ` +处置费 ¥${feeAmount}` : ''}${cogsAmount ? `；联营批次成本 ¥${cogsAmount} 随结算账单付商户` : ''}`, { staffId })
      return { ok: true, id: rrid, refundAmount, compAmount, feeAmount, cogsAmount, kind }
    })
  }
  try { return idemRun('recall_refund', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// 召回批次平均单位成本（联营已售退款的批次成本退还要素）
function avgRecalledUnitCost(recallId, materialId) {
  const mid = num(materialId)
  const r = db.prepare(`SELECT COALESCE(SUM(b.qty_received*b.unit_cost),0) c, COALESCE(SUM(b.qty_received),0) q
                        FROM recall_batches rb JOIN inbound_batches b ON b.id=rb.batch_id
                        WHERE rb.recall_id=? AND (?=0 OR b.material_id=?)`)
    .get(recallId, mid, mid)
  return num(r.q) > 0 ? Math.round((num(r.c) / num(r.q)) * 100) / 100 : 0
}

// 按商铺汇总召回物资已售流出（来自 stock_movements sale/partner_sale，按召回批次收货日起算）
function soldByVendor(recallId) {
  const r = getRecall(recallId)
  const items = db.prepare('SELECT * FROM recall_items WHERE recall_id=?').all(recallId)
  const matIds = items.map(x => x.material_id)
  const batchIds = db.prepare('SELECT batch_id FROM recall_batches WHERE recall_id=?').all(recallId).map(x => x.batch_id)
  let dayFrom = db.prepare(`SELECT COALESCE(MIN(b.receive_day),0) d FROM recall_batches rb JOIN inbound_batches b ON b.id=rb.batch_id WHERE rb.recall_id=?`).get(recallId).d
  if (!dayFrom) {
    const row = db.prepare(`SELECT COALESCE(MIN(receive_day),0) d FROM inbound_batches
                            WHERE supplier_id=? AND material_id IN (${matIds.map(() => '?').join(',') || '0'})`).get(batchSupplier, ...matIds)
    dayFrom = row?.d || 0
  }
  const map = ctx.recallOutflow
    ? ctx.recallOutflow(matIds, batchIds.length
        ? { batchIds, dayFrom, dayTo: ctx.day() }
        : { supplierId: batchSupplier, dayFrom, dayTo: ctx.day() })
    : new Map()
  return [...map.values()].map(e => ({
    vendorId: e.vendorId,
    soldQty: round1(e.qty),
    vendor: db.prepare('SELECT id,name,price,type FROM vendors WHERE id=?').get(e.vendorId),
    partner: !!(ctx.activePartnerContract && ctx.activePartnerContract(e.vendorId)),
    materials: [...e.byMaterial.entries()].map(([materialId, qty]) => ({ materialId, qty: round1(qty) }))
  })).filter(x => x.vendor)
}

// ---------------- 供应商赔付 ----------------
export function payRecall(id, amount, { note = '', staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    const due = Math.max(0, Math.round(r.cash_due - r.supplier_paid))
    const pay = Math.round(num(amount))
    if (pay <= 0) return { ok: false, code: 'BAD_ARG', msg: '赔付金额须大于 0' }
    if (pay > due) return { ok: false, code: 'OVER_PAY', msg: `赔付不能超过供应商现金应付 ¥${due}` }
    return tx(() => {
      setSetting('cash', Math.round(ctx.cash() + pay))
      db.prepare('UPDATE recalls SET supplier_paid=supplier_paid+? WHERE id=?').run(pay, r.id)
      ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_COMP, pay, `供应商「${getSupplier(r.supplier_id)?.name}」召回赔付 ${r.code}（已付货款退回+游客退款赔付+处置费）`)
      logRecall(r.id, 'supplier_pay', `供应商现金赔付 ¥${pay}，剩余应付 ¥${due - pay}${note ? '；' + note : ''}`, { actor: 'supplier', staffId })
      return { ok: true, paid: pay, due: due - pay }
    })
  }
  try { return idemRun('recall_pay', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// ---------------- 结案 ----------------
// 前置：全部已隔离批次已退回或销毁；已售退款登记完成（允许未全退，未退部分计园方损失）
// 供应商未赔现金可选择挂账追偿（write_off=false，保持账单）或核销计园方损失（write_off=true）
export function closeRecall(id, { writeOff = false, suspendSupplier = null, note = '', staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (r.status === 'closed') return { ok: false, code: 'BAD_STATE', msg: '召回单已结案' }
    if (r.status === 'cancelled') return { ok: false, code: 'BAD_STATE', msg: '召回单已撤销' }
    const held = db.prepare("SELECT COALESCE(SUM(quarantined_qty-returned_qty-destroyed_qty),0) q FROM recall_batches WHERE recall_id=? AND status IN ('quarantined','partial')").get(r.id).q
    return tx(() => {
      let destroyCost = 0, destroyQty = 0
      // 隔离余货：供应商不收回，结案统一销毁报损（现存核减，计园方损失）
      for (const rb of db.prepare("SELECT * FROM recall_batches WHERE recall_id=? AND status='quarantined'").all(r.id)) {
        const b = db.prepare('SELECT * FROM inbound_batches WHERE id=?').get(rb.batch_id)
        if (b && b.qty_remain > 0) {
          const res = ctx.recallDestroyBatch(b.id, b.qty_remain, r.id)
          destroyQty = round1(destroyQty + res.qty)
          destroyCost += res.cost
          db.prepare("UPDATE recall_batches SET destroyed_qty=destroyed_qty+?,status='destroyed',update_tick=? WHERE id=?")
            .run(res.qty, ctx.tick(), rb.id)
          db.prepare('UPDATE recall_items SET destroyed_qty=destroyed_qty+? WHERE id=?').run(res.qty, rb.item_id)
        }
      }
      if (destroyCost > 0) {
        setSetting('cash', Math.round(ctx.cash() - destroyCost))
        ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_LOSS, -destroyCost, `召回 ${r.code} 问题商品销毁报损（供应商不收回，计园方损失）`)
      }

      // 供应商未赔现金：挂账追偿 or 核销计园方损失
      const unpaid = Math.max(0, Math.round(r.cash_due - r.supplier_paid))
      let loss = destroyCost
      if (unpaid > 0 && writeOff) {
        loss += unpaid
        if (unpaid > 0) ctx.logFinance?.(ctx.day(), RECALL_CONST.FIN_LOSS, -unpaid, `召回 ${r.code} 供应商应付赔付款无法追回，核销计园方损失`)
      }

      // 供应商评级：严重 -1、紧急 -2；紧急且供应商未接受召回时默认暂停合作（前端可显式覆盖）
      const ratingDelta = r.severity >= 3 ? -2 : r.severity === 2 ? -1 : 0
      if (ratingDelta && ctx.adjustSupplierRating) ctx.adjustSupplierRating(r.supplier_id, ratingDelta)
      const doSuspend = suspendSupplier === null ? (r.severity >= 3 && !r.supplier_accepted) : !!suspendSupplier
      if (doSuspend && ctx.setSupplierStatus) ctx.setSupplierStatus(r.supplier_id, 'suspended')

      db.prepare(`UPDATE recalls SET status='closed',destroyed_qty=destroyed_qty+?,park_loss=?,rating_delta=?,suspend_supplier=?,
                  close_note=?,close_tick=?,close_day=? WHERE id=?`)
        .run(destroyQty, loss, ratingDelta, doSuspend ? 1 : 0, String(note || ''), ctx.tick(), ctx.day(), r.id)
      logRecall(r.id, 'close',
        `召回结案：退回 ${r.returned_qty} / 销毁 ${round1(r.destroyed_qty + destroyQty)} 份；游客退款 ¥${r.customer_refund_total + num(0)}、赔付 ¥${r.customer_comp_total}；供应商应赔 ¥${r.billed_amount}（已现金赔付 ¥${r.supplier_paid}${unpaid ? `，未追回 ¥${unpaid}${writeOff ? ' 已核销' : ' 挂账追偿'}` : ''}）；评级 ${ratingDelta} 星${doSuspend ? '，已暂停合作' : ''}`,
        { staffId })

      // 关联投诉随召回结案无争议闭环
      const linked = safeJson(r.linked_complaint_ids, [])
      for (const cid of linked) {
        ctx.closeComplaintLinked?.(cid, { code: r.code }, 'event_review', { note: `供应商批次召回 ${r.code} 已完成退货退款赔付` })
      }
      emitEvent('recall', `✅ 召回 ${r.code} 已结案`,
        `供应商「${getSupplier(r.supplier_id)?.name}」批次召回完成闭环：退货 ${r.returned_qty} 份、销毁 ${round1(r.destroyed_qty + destroyQty)} 份、游客退款赔付 ¥${r.customer_refund_total + r.customer_comp_total}；供应商赔付 ¥${r.supplier_paid}/${r.cash_due}${unpaid ? `（未追回 ¥${unpaid}）` : ''}。`, 0)
      return { ok: true, destroyQty, destroyCost, unpaid, parkLoss: loss, suspended: doSuspend }
    })
  }
  try { return idemRun('recall_close', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

function safeJson(s, d) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : d } catch { return d } }

// 撤销召回（仅在未隔离/未退款前）：解除批次标记
export function cancelRecall(id, { note = '', staffId = null, requestId = '' } = {}) {
  const run = () => {
    const r = getRecall(id)
    if (!r) return { ok: false, code: 'NOT_FOUND', msg: '召回单不存在' }
    if (r.quarantined_qty > 0 || r.returned_qty > 0 || r.refunded_qty > 0) {
      return { ok: false, code: 'BAD_STATE', msg: '已隔离/退货/退款的召回不能撤销，请走结案流程' }
    }
    return tx(() => {
      for (const rb of db.prepare("SELECT * FROM recall_batches WHERE recall_id=? AND status='pending'").all(r.id)) {
        db.prepare("UPDATE recall_batches SET status='released' WHERE id=?").run(rb.id)
      }
      db.prepare("UPDATE recalls SET status='cancelled',close_note=?,close_tick=?,close_day=? WHERE id=?")
        .run(String(note || '误报/核实无问题，撤销召回'), ctx.tick(), ctx.day(), r.id)
      logRecall(r.id, 'cancel', `撤销召回：${note || '核实无质量问题'}`, { staffId })
      emitEvent('recall', `🚫 召回 ${r.code} 已撤销`, `供应商「${getSupplier(r.supplier_id)?.name}」召回 ${r.code} 经核实撤销，批次恢复销售。`, 0)
      return { ok: true }
    })
  }
  try { return idemRun('recall_cancel', requestId, run) }
  catch (e) { return { ok: false, code: e.code || 'TX_FAILED', msg: e.message } }
}

// 每小时推进：供应商超时未应答 → 事件通知（去重）
export function processRecallTick() {
  try {
    const rows = db.prepare("SELECT * FROM recalls WHERE status='issued' AND overdue_notice_tick=0").all()
    for (const r of rows) {
      if (ctx.tick() - r.create_tick < RECALL_CONST.ACK_SLA_TICKS) continue
      db.prepare('UPDATE recalls SET overdue_notice_tick=? WHERE id=?').run(ctx.tick(), r.id)
      logRecall(r.id, 'overdue', `供应商超过 ${RECALL_CONST.ACK_SLA_TICKS} 小时未应答，系统事件通知运营强制推进`, { actor: 'system' })
      emitEvent('recall', `⏰ 供应商召回 ${r.code} 超时未应答`,
        `供应商「${getSupplier(r.supplier_id)?.name}」超过应答时限未确认召回 ${r.code}，问题批次仍待隔离。请立即强制推进并安排隔离，防止问题商品继续销售。`, -2)
    }
  } catch (e) {
    console.error('[recalls] 召回模块小时推进失败（不影响主循环）:', e)
  }
}

// ---------------- 查询 ----------------
function enrichRecall(r) {
  const supplier = getSupplier(r.supplier_id)
  const items = db.prepare('SELECT * FROM recall_items WHERE recall_id=?').all(r.id).map(it => ({
    ...it, material_name: getMaterial(it.material_id)?.name || '', unit: getMaterial(it.material_id)?.unit || ''
  }))
  const batches = db.prepare(`SELECT rb.*, b.code batch_code, b.unit_cost, b.expire_day, b.receive_day,
                              m.name material_name, m.unit
                              FROM recall_batches rb
                              JOIN inbound_batches b ON b.id=rb.batch_id
                              JOIN materials m ON m.id=b.material_id
                              WHERE rb.recall_id=? ORDER BY rb.id`).all(r.id)
  const refunds = db.prepare(`SELECT rr.*, v.name vendor_name, v.type vendor_type, pc.code contract_code
                              FROM recall_refunds rr LEFT JOIN vendors v ON v.id=rr.vendor_id
                              LEFT JOIN partner_contracts pc ON pc.id=rr.contract_id
                              WHERE rr.recall_id=? ORDER BY rr.id`).all(r.id)
  const logs = db.prepare('SELECT * FROM recall_logs WHERE recall_id=? ORDER BY id').all(r.id)
  const linked = safeJson(r.linked_complaint_ids, [])
  const cashUnpaid = Math.max(0, Math.round(r.cash_due - r.supplier_paid))
  return {
    ...r,
    supplier_name: supplier?.name || '',
    supplier_status: supplier?.status || '',
    supplier_rating: supplier?.rating || 0,
    reason_name: RECALL_CONST.REASON[r.reason_type] || r.reason_type,
    severity_name: RECALL_CONST.SEVERITY[r.severity] || '',
    items, batches, refunds, logs,
    linked_complaints: linked,
    cash_unpaid: cashUnpaid,
    overdue: r.status === 'issued' && ctx.tick() - r.create_tick >= RECALL_CONST.ACK_SLA_TICKS
  }
}

export function listRecalls({ status = null, supplierId = null, limit = 100 } = {}) {
  let rows
  if (status) rows = db.prepare('SELECT * FROM recalls WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
  else rows = db.prepare('SELECT * FROM recalls ORDER BY id DESC LIMIT ?').all(limit)
  if (supplierId) rows = rows.filter(r => r.supplier_id === num(supplierId))
  return rows.map(r => {
    const supplier = getSupplier(r.supplier_id)
    const refundCount = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM recall_refunds WHERE recall_id=?').get(r.id)
    const batchCount = db.prepare("SELECT COUNT(*) n FROM recall_batches WHERE recall_id=? AND status IN ('pending','quarantined','partial')").get(r.id).n
    return {
      ...r,
      supplier_name: supplier?.name || '',
      reason_name: RECALL_CONST.REASON[r.reason_type] || r.reason_type,
      severity_name: RECALL_CONST.SEVERITY[r.severity] || '',
      refund_count: refundCount.n,
      refund_vendor_qty: round1(refundCount.q),
      pending_batches: batchCount,
      cash_unpaid: Math.max(0, Math.round(r.cash_due - r.supplier_paid)),
      overdue: r.status === 'issued' && ctx.tick() - r.create_tick >= RECALL_CONST.ACK_SLA_TICKS
    }
  })
}

export function recallDetail(id) {
  const r = getRecall(id)
  if (!r) return null
  const d = enrichRecall(r)
  // 可退款商铺建议（已售流向）
  d.sold_vendors = soldByVendor(r.id).map(x => ({
    ...x,
    refunded_qty: round1(num(db.prepare('SELECT COALESCE(SUM(qty),0) q FROM recall_refunds WHERE recall_id=? AND vendor_id=?').get(r.id, x.vendorId).q))
  }))
  d.const = { ackSlaTicks: RECALL_CONST.ACK_SLA_TICKS, severity: RECALL_CONST.SEVERITY, reason: RECALL_CONST.REASON }
  return d
}

export function recallStats() {
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const byStatus = {}
  for (const s of ['issued', 'acknowledged', 'quarantining', 'refunding', 'closed', 'cancelled']) {
    byStatus[s] = one('SELECT COUNT(*) n FROM recalls WHERE status=?', s).n
  }
  const overdue = one("SELECT COUNT(*) n FROM recalls WHERE status='issued' AND (? - create_tick) >= ?", ctx.tick(), RECALL_CONST.ACK_SLA_TICKS).n
  const row = one(`SELECT
      COALESCE(SUM(affected_qty),0) affected,
      COALESCE(SUM(quarantined_qty),0) quarantined,
      COALESCE(SUM(returned_qty),0) returned,
      COALESCE(SUM(destroyed_qty),0) destroyed,
      COALESCE(SUM(sold_qty),0) sold,
      COALESCE(SUM(refunded_qty),0) refunded,
      COALESCE(SUM(billed_amount),0) billed,
      COALESCE(SUM(supplier_paid),0) paid,
      COALESCE(SUM(cash_due - supplier_paid),0) unpaid,
      COALESCE(SUM(park_loss),0) loss
      FROM recalls`)
  return {
    ...byStatus,
    open: byStatus.issued + byStatus.acknowledged + byStatus.quarantining + byStatus.refunding,
    overdueSuppliers: overdue,
    qty: {
      affected: round1(num(row.affected)), quarantined: round1(num(row.quarantined)),
      returned: round1(num(row.returned)), destroyed: round1(num(row.destroyed)),
      sold: round1(num(row.sold)), refunded: round1(num(row.refunded))
    },
    billed: Math.round(num(row.billed)),
    supplierPaid: Math.round(num(row.paid)),
    cashUnpaid: Math.round(Math.max(0, num(row.unpaid))),
    parkLoss: Math.round(num(row.loss))
  }
}
