<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const tabs = [
  { k: 'open', icon: '🚨', label: '在途召回' },
  { k: 'closed', icon: '✅', label: '已结案' },
  { k: 'all', icon: '📋', label: '全部' }
]
const tab = ref('open')

const STATUS = {
  issued: { t: '待供应商应答', c: 'var(--accent2)' },
  forced: { t: '园方强制推进', c: 'var(--purple)' },
  acknowledged: { t: '供应商已接受', c: 'var(--blue)' },
  quarantining: { t: '隔离退货中', c: '#58c4dd' },
  refunding: { t: '退款赔付中', c: 'var(--purple)' },
  closed: { t: '已结案', c: 'var(--green)' },
  cancelled: { t: '已撤销', c: 'var(--muted)' }
}
const stMeta = s => STATUS[s] || { t: s, c: 'var(--muted)' }
const sevTag = s => s >= 3 ? 'tag-red' : s === 2 ? 'tag-warn' : 'tag-on'

const stats = computed(() => store.recallStats)

const list = computed(() => {
  const all = store.recalls
  if (tab.value === 'open') return all.filter(r => ['issued', 'forced', 'acknowledged', 'quarantining', 'refunding'].includes(r.status))
  if (tab.value === 'closed') return all.filter(r => ['closed', 'cancelled'].includes(r.status))
  return all
})

// ---------------- 发起召回 ----------------
const createModal = ref(false)
const form = ref(null)
const candidates = ref([])

function blankForm() {
  return {
    supplier_id: store.suppliers[0]?.id || null,
    reason_type: 'safety',
    severity: 2,
    title: '',
    reason: '',
    extra_comp: 0,
    handling_fee: 0,
    lines: [{ material_id: store.materials[0]?.id || null, batch_ids: [] }]
  }
}
function openCreate(prefill = null) {
  form.value = prefill ? { ...blankForm(), ...prefill } : blankForm()
  candidates.value = []
  loadCandidates()
  createModal.value = true
}
async function loadCandidates() {
  if (!form.value.supplier_id) { candidates.value = []; return }
  const r = await store.recallCandidates(`?supplier_id=${form.value.supplier_id}`)
  candidates.value = r.list || []
}
function batchesOf(line) {
  return candidates.value.filter(b => b.material_id === +line.material_id && (b.supplier_id === +form.value.supplier_id))
}
function addLine() { form.value.lines.push({ material_id: store.materials[0]?.id || null, batch_ids: [] }) }
function removeLine(i) { form.value.lines.splice(i, 1) }
function toggleBatch(line, bid, ev) {
  const ids = line.batch_ids
  const i = ids.indexOf(bid)
  if (ev.target.checked && i < 0) ids.push(bid)
  if (!ev.target.checked && i >= 0) ids.splice(i, 1)
}
async function submitCreate() {
  const items = form.value.lines
    .filter(l => l.material_id && (l.batch_ids.length || true))
    .map(l => ({ material_id: +l.material_id, batch_ids: l.batch_ids.map(Number) }))
  if (!items.length) return alert('请至少添加一项物资（勾选批次或留空由系统自动按 FEFO 选取）')
  const r = await store.createRecall({
    supplier_id: +form.value.supplier_id,
    reason_type: form.value.reason_type,
    severity: +form.value.severity,
    title: form.value.title,
    reason: form.value.reason,
    extra_comp: +form.value.extra_comp || 0,
    handling_fee: +form.value.handling_fee || 0,
    items
  })
  if (r.ok) createModal.value = false
  else alert(r.msg || '发起失败')
}

// ---------------- 详情 ----------------
const detail = ref(null)
const payAmount = ref(0)
const refundVendor = ref(null)
const refundQty = ref(1)
const refundNote = ref('')

async function openDetail(r) {
  const res = await store.recallDetail(r.id)
  if (!res.ok) return alert(res.msg || '加载失败')
  detail.value = res.data
  payAmount.value = res.data.cash_unpaid
  refundVendor.value = res.data.sold_vendors[0]?.vendorId || null
  refundQty.value = 1
  refundNote.value = ''
}
function closeDetail() { detail.value = null }

async function act(fn, ...args) {
  const r = await fn(...args)
  if (!r?.ok) { alert(r?.msg || '操作失败'); return r }
  if (detail.value) await openDetail({ id: detail.value.id })
  return r
}

async function doAck(accept) {
  const note = prompt(accept ? '供应商应答说明（可留空）' : '供应商异议理由', '') ?? null
  if (note === null) return
  await act(() => store.acknowledgeRecall(detail.value.id, { accept, note }))
}
async function doForce() {
  const note = prompt('强制推进理由（供应商超时/异议不成立）', '供应商超时未应答，按食安预案先行处置') ?? ''
  if (note === null) return
  await act(() => store.forceRecall(detail.value.id, { note }))
}
async function doQuarantine() {
  await act(() => store.quarantineRecall(detail.value.id, {}))
}
async function doReturn() {
  if (!confirm('确认将全部已隔离批次退回供应商？未付货款冲采购应付，已付部分登记供应商现金应退。')) return
  await act(() => store.returnRecall(detail.value.id, {}))
}
async function doRefund() {
  const v = detail.value.sold_vendors.find(x => x.vendorId === +refundVendor.value)
  if (!v) return alert('请选择有已售流向的商铺')
  const left = Math.round((v.soldQty - v.refunded_qty) * 10) / 10
  if (!refundQty.value || refundQty.value <= 0) return alert('退款数量须大于 0')
  if (refundQty.value > left) return alert(`最多还可退 ${left} 份`)
  const kindText = v.partner ? '联营（园方垫付游客+分账红冲，批次成本/处置费随结算账单付商户）' : '自营（园方现金直退）'
  if (!confirm(`确认对「${v.vendor.name}」召回退款 ${refundQty.value} 份（${kindText}）？`)) return
  await act(() => store.refundRecall(detail.value.id, {
    vendor_id: v.vendorId, qty: +refundQty.value, note: refundNote.value
  }))
}
async function doPay() {
  if (!payAmount.value || payAmount.value <= 0) return
  await act(() => store.payRecall(detail.value.id, +payAmount.value, '供应商现金赔付'))
}
async function doClose() {
  const unpaid = detail.value.cash_unpaid
  const writeOff = unpaid > 0 ? confirm(`供应商尚有 ¥${unpaid} 未赔付。\n确定=无法追回，核销计园方损失；取消=保留挂账继续追偿（仍可结案）。`) : false
  const suspend = detail.value.severity >= 3
    ? confirm('是否同时暂停该供应商合作？（紧急召回建议暂停）\n确定=暂停合作，取消=保留合作资格')
    : false
  const note = prompt('结案说明（可留空）', '') ?? ''
  await act(() => store.closeRecall(detail.value.id, { write_off: writeOff, suspend_supplier: suspend, note }))
}
async function doCancel() {
  if (!confirm('撤销后批次恢复销售。仅在尚未隔离/退款前可撤销，确认继续？')) return
  const r = await act(() => store.cancelRecall(detail.value.id, '核实无问题'))
  if (r?.ok) closeDetail()
}

const LOG_ACTION = {
  create: '发起召回', acknowledge: '供应商接受', dispute: '供应商异议', force: '园方强制推进',
  quarantine: '批次隔离', return: '退回供应商', refund_sold: '已售退款',
  supplier_pay: '供应商赔付', close: '结案', cancel: '撤销召回', overdue: '超时通知'
}
const logActor = a => ({ operations: '园方', supplier: '供应商', system: '系统' }[a] || a)
</script>

<template>
  <div class="rc">
    <!-- KPI -->
    <div class="kpis">
      <div class="kpi card"><em>在途召回</em><b :class="stats.open ? 'neg money' : ''">{{ stats.open }}</b><span class="muted">待供应商应答 {{ stats.issued }} · 超时 {{ stats.overdueSuppliers }}</span></div>
      <div class="kpi card"><em>隔离 / 已退供应商</em><b>{{ stats.qty.quarantined }} / {{ stats.qty.returned }}</b><span class="muted">销毁 {{ stats.qty.destroyed }} 份</span></div>
      <div class="kpi card"><em>已售召回退款</em><b>{{ stats.qty.refunded }} / {{ stats.qty.sold }}</b><span class="muted">已识别流向商铺份数</span></div>
      <div class="kpi card"><em>供应商应赔</em><b class="money">¥{{ stats.billed.toLocaleString() }}</b><span class="muted">已现金赔付 ¥{{ stats.supplierPaid.toLocaleString() }}</span></div>
      <div class="kpi card"><em>待追偿现金</em><b class="money neg" v-if="stats.cashUnpaid">¥{{ stats.cashUnpaid.toLocaleString() }}</b><b v-else>¥0</b><span class="muted">已付货款退回+退款+处置费</span></div>
      <div class="kpi card"><em>园方净损失</em><b class="money neg">¥{{ stats.parkLoss.toLocaleString() }}</b><span class="muted">销毁成本+核销应收</span></div>
    </div>

    <div class="bar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">
          <span>{{ t.icon }}</span>{{ t.label }}
          <i class="badge red" v-if="t.k === 'open' && stats.open">{{ stats.open }}</i>
        </button>
      </div>
      <button class="primary" @click="openCreate()">＋ 发起供应商批次召回</button>
    </div>

    <div class="table card">
      <div class="thead rl-head">
        <span>召回单</span><span>供应商</span><span>原因/等级</span><span>涉及/隔离/退货</span>
        <span>已售/已退</span><span>应赔/已赔/待追偿</span><span>状态</span><span>操作</span>
      </div>
      <div class="trow rl-head" v-for="r in list" :key="r.id">
        <span><b>{{ r.code }}</b><em class="muted code">{{ r.title }}</em></span>
        <span>{{ r.supplier_name }}<em class="muted code">★{{ r.supplier_rating }} · {{ r.supplier_status === 'active' ? '合作中' : '已暂停' }}</em></span>
        <span>{{ r.reason_name }}<em class="tag" :class="sevTag(r.severity)">{{ r.severity_name }}</em><em class="tag red-tag" v-if="r.overdue">超时未应答</em></span>
        <span>{{ r.affected_qty }} / {{ r.quarantined_qty }} / {{ r.returned_qty }}</span>
        <span>{{ r.sold_qty }} / {{ r.refunded_qty }}</span>
        <span>
          <span class="money">¥{{ r.billed_amount }}</span>
          <em class="muted"> / ¥{{ r.supplier_paid }}</em>
          <em class="money neg" v-if="r.cash_unpaid"> / ¥{{ r.cash_unpaid }}</em>
        </span>
        <span><i class="dot" :style="{ color: stMeta(r.status).c }">●</i> {{ stMeta(r.status).t }}</span>
        <span class="ops"><button class="ghost" @click="openDetail(r)">处置</button></span>
      </div>
      <div class="muted empty" v-if="!list.length">暂无召回单</div>
    </div>

    <!-- ============ 发起召回弹窗 ============ -->
    <div class="modal" v-if="createModal" @click.self="createModal = false">
      <div class="modal-box card wide">
        <h3>🔁 发起供应商批次召回</h3>
        <div class="form">
          <div class="form-row">
            <label>供应商
              <select v-model.number="form.supplier_id" @change="loadCandidates">
                <option v-for="s in store.suppliers" :key="s.id" :value="s.id">{{ s.name }}（{{ s.category }}）</option>
              </select>
            </label>
            <label>召回原因
              <select v-model="form.reason_type">
                <option v-for="(name, k) in store.recallConst.reasonNames" :key="k" :value="k">{{ name }}</option>
              </select>
            </label>
            <label>紧急等级
              <select v-model.number="form.severity">
                <option :value="1">一般</option><option :value="2">严重</option><option :value="3">紧急（超时自动通知/可暂停合作）</option>
              </select>
            </label>
          </div>
          <label>召回标题 <input v-model="form.title" placeholder="留空则自动生成" /></label>
          <label>问题描述/召回依据 <input v-model="form.reason" placeholder="如：抽检微生物超标/监管通报/游客集中投诉" /></label>
          <div class="form-row">
            <label>已售商品额外赔付（¥/份，供应商承担）<input type="number" min="0" v-model.number="form.extra_comp" /></label>
            <label>召回处置费（¥/份，供应商承担）<input type="number" min="0" v-model.number="form.handling_fee" /></label>
          </div>

          <div class="lines">
            <div class="line-h"><span>召回物资</span><span>问题批次（勾选隔离；留空自动按 FEFO 选取该供应商批次）</span><span style="width:40px"></span></div>
            <div class="line-block" v-for="(l, i) in form.lines" :key="i">
              <select v-model.number="l.material_id" style="width:200px">
                <option v-for="m in store.materials" :key="m.id" :value="m.id">{{ m.name }}（可用 {{ m.qty_on_hand }}{{ m.unit }}）</option>
              </select>
              <div class="batchpicks">
                <label v-for="b in batchesOf(l)" :key="b.id" :class="{ disabled: b.status !== 'in' }">
                  <input type="checkbox" :checked="l.batch_ids.includes(b.id)" :disabled="b.status !== 'in'" @change="e => toggleBatch(l, b.id, e)" />
                  {{ b.code }} · 余{{ b.qty_remain }}{{ b.unit }} · ¥{{ b.unit_cost }}<em class="muted" v-if="b.status !== 'in'">（已隔离）</em>
                </label>
                <em class="muted" v-if="!batchesOf(l).length">该供应商无此物资在库批次，可留空由系统自动匹配</em>
              </div>
              <button class="ghost danger" @click="removeLine(i)">✕</button>
            </div>
            <button class="ghost" @click="addLine">＋ 添加物资</button>
          </div>
          <p class="muted" style="font-size:12px">发起后：问题批次进入待隔离（FEFO 即刻停售）；供应商需在 {{ store.recallConst.ackSlaTicks }} 小时内应答；严重/紧急召回将自动生成餐饮质量投诉并推送事件通知，结案时投诉随召回闭环。</p>
        </div>
        <div class="acts"><button class="primary" @click="submitCreate">发布召回</button><button class="ghost" @click="createModal = false">取消</button></div>
      </div>
    </div>

    <!-- ============ 召回处置详情 ============ -->
    <div class="modal" v-if="detail" @click.self="closeDetail">
      <div class="modal-box card wide">
        <h3>🔁 {{ detail.code }}
          <i class="dot" :style="{ color: stMeta(detail.status).c }">●</i>{{ stMeta(detail.status).t }}
          <em class="tag" :class="sevTag(detail.severity)">{{ detail.severity_name }}</em>
          <em class="tag">{{ detail.reason_name }}</em>
        </h3>
        <div class="d-meta">
          <span>供应商：<b>{{ detail.supplier_name }}</b>（★{{ detail.supplier_rating }} · {{ detail.supplier_status === 'active' ? '合作中' : '已暂停' }}）</span>
          <span>应赔合计：<b class="money">¥{{ detail.billed_amount }}</b></span>
          <span>冲应付：¥{{ detail.credit_amount }}</span>
          <span>现金应收：<b class="money neg">¥{{ detail.cash_due }}</b></span>
          <span>已赔付：<b class="money">¥{{ detail.supplier_paid }}</b></span>
          <span>待追偿：<b class="money neg" v-if="detail.cash_unpaid">¥{{ detail.cash_unpaid }}</b><em v-else class="muted">已结清</em></span>
          <span>园方损失：¥{{ detail.park_loss }}</span>
        </div>
        <p class="muted" style="font-size:12px;margin:6px 0">{{ detail.title }} · {{ detail.reason || '—' }}
          <em class="tag red-tag" v-if="detail.overdue">供应商超时未应答</em>
        </p>
        <p class="muted" v-if="detail.supplier_response" style="font-size:12px">供应商应答：{{ detail.supplier_response }}</p>

        <!-- 操作区（按状态推进） -->
        <div class="d-acts">
          <template v-if="detail.status === 'issued'">
            <button class="succ" @click="doAck(true)">供应商接受召回</button>
            <button class="ghost" @click="doAck(false)">供应商提出异议</button>
            <button class="danger" @click="doForce">园方强制推进</button>
          </template>
          <button v-if="['acknowledged','quarantining','refunding','issued','forced'].includes(detail.status)" class="succ" @click="doQuarantine">🛑 隔离在库批次（停售）</button>
          <button v-if="detail.batches.some(b => b.status === 'quarantined')" @click="doReturn">↩️ 退回供应商</button>
          <button v-if="detail.cash_unpaid > 0 && detail.status !== 'cancelled'" @click="doPay">💰 登记供应商赔付 ¥{{ payAmount }}</button>
          <button v-if="['acknowledged','quarantining','refunding','issued','forced'].includes(detail.status)" class="succ" @click="doClose">✅ 结案（余货销毁/评级/投诉闭环）</button>
          <button v-if="detail.quarantined_qty === 0 && detail.refunded_qty === 0 && detail.returned_qty === 0" class="danger" @click="doCancel">撤销召回</button>
        </div>

        <!-- 批次明细 -->
        <div class="mini-table" v-if="detail.batches.length">
          <div class="mini-head rb-head"><span>批次</span><span>物资</span><span>在库余量</span><span>已隔离</span><span>已退货</span><span>单价</span><span>状态</span></div>
          <div class="mini-row rb-head" v-for="b in detail.batches" :key="b.id">
            <span>{{ b.batch_code }}</span>
            <span>{{ b.material_name }}<em class="muted code">{{ b.expire_day ? `第${b.expire_day}天到期` : '无保质期' }}</em></span>
            <span>{{ b.qty }}</span><span>{{ b.quarantined_qty }}</span><span>{{ b.returned_qty }}</span>
            <span>¥{{ b.unit_cost }}</span>
            <span>{{ {pending:'待隔离', quarantined:'已隔离停售', partial:'部分退回', returned:'已退供应商', destroyed:'已销毁', released:'已解除'}[b.status] }}</span>
          </div>
        </div>
        <p class="muted" v-else style="font-size:12px">未预锁批次，隔离时系统将自动按 FEFO 选取该供应商在库批次。</p>

        <!-- 已售退款 -->
        <div class="refund-box card" v-if="detail.status !== 'cancelled'">
          <h3>🏪 已售商品召回退款（园方 + 联营商户协同）</h3>
          <div v-if="detail.sold_vendors.length" class="refund-form">
            <select v-model.number="refundVendor">
              <option v-for="v in detail.sold_vendors" :key="v.vendorId" :value="v.vendorId">
                {{ v.vendor.name }}（{{ v.partner ? '联营' : '自营' }}）已售 {{ v.soldQty }} · 已退 {{ v.refunded_qty }}
              </option>
            </select>
            <input type="number" min="1" v-model.number="refundQty" style="width:100px" />
            <input v-model="refundNote" placeholder="退款备注（可留空）" style="flex:1" />
            <button class="primary" @click="doRefund">登记召回退款</button>
          </div>
          <p class="muted" v-else style="font-size:12px">未识别到该批次商品流向商铺的销售记录。</p>
          <div class="mini-table" v-if="detail.refunds.length">
            <div class="mini-head rf-head"><span>退款单</span><span>商铺</span><span>性质</span><span>份数</span><span>游客货款</span><span>额外赔付</span><span>处置费</span><span>联营成本/账单</span></div>
            <div class="mini-row rf-head" v-for="rf in detail.refunds" :key="rf.id">
              <span>{{ rf.code }}</span><span>{{ rf.vendor_name }}</span>
              <span><em class="tag" :class="rf.kind === 'partner' ? 'tag-warn' : 'tag-on'">{{ rf.kind === 'partner' ? '联营' : '自营' }}</em></span>
              <span>{{ rf.qty }}</span>
              <span class="money neg">¥{{ rf.refund_amount }}</span>
              <span class="money neg" v-if="rf.comp_amount">¥{{ rf.comp_amount }}</span><em v-else class="muted">—</em>
              <span>¥{{ rf.fee_amount }}</span>
              <span v-if="rf.kind === 'partner'">¥{{ rf.cogs_amount }} <em class="tag" v-if="rf.settlement_id">{{ rf.contract_code ? '' : '' }}账单#{{ rf.settlement_id }}</em><em class="tag tag-warn" v-else>待出账</em></span><em v-else class="muted">—</em>
            </div>
          </div>
        </div>

        <!-- 时间线 -->
        <div class="logs">
          <b class="muted">处置时间线</b>
          <div v-for="lg in detail.logs" :key="lg.id" class="log-line">
            <span class="muted">第{{ lg.day }}天</span>
            <em class="tag">{{ logActor(lg.actor_role) }}</em>
            <b>{{ LOG_ACTION[lg.action] || lg.action }}</b> {{ lg.note }}
          </div>
        </div>
        <div class="acts"><button class="ghost" @click="closeDetail">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rc { display: flex; flex-direction: column; gap: 14px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; }
.kpi { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; }
.kpi em { font-style: normal; font-size: 12px; color: var(--muted); }
.kpi b { font-size: 21px; }
.kpi span { font-size: 11px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; }
.tabs button { position: relative; display: flex; align-items: center; gap: 6px; }
.tabs button.on { border-color: var(--accent); color: var(--accent); background: rgba(255,107,107,.1); }
.badge { font-style: normal; font-size: 10px; background: var(--red); color: #fff; border-radius: 10px; padding: 0 6px; line-height: 16px; }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 1000px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.rl-head { grid-template-columns: 1.3fr 1.1fr 1fr .9fr .7fr 1.2fr 1fr .6fr; }
.code { display: block; font-size: 11px; font-style: normal; }
.dot { font-style: normal; font-size: 10px; margin-right: 4px; }
.ops { display: flex; gap: 6px; }
.empty { padding: 18px; text-align: center; }
.tag-on { color: var(--green); border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.12); }
.tag-warn { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.12); }
.tag-red { color: var(--red); border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.15); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal-box { width: min(560px,94vw); max-height: 88vh; overflow-y: auto; }
.modal-box.wide { width: min(860px,95vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.form-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.form-row label { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 5px; }
.acts { display: flex; gap: 8px; }
.lines { display: flex; flex-direction: column; gap: 6px; }
.line-h { display: flex; gap: 8px; font-size: 11px; color: var(--muted); }
.line-h span:first-child { width: 200px; }
.line-block { display: flex; gap: 8px; align-items: flex-start; background: var(--panel2); border-radius: 10px; padding: 8px; }
.batchpicks { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.batchpicks label { display: flex; flex-direction: row; align-items: center; gap: 6px; font-size: 12px; color: var(--text); }
.batchpicks label.disabled { opacity: .6; }
.d-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; margin: 10px 0; }
.d-acts { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.mini-table { margin: 10px 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.mini-head, .mini-row { display: grid; gap: 8px; padding: 8px 12px; font-size: 12.5px; align-items: center; }
.mini-head { background: var(--panel2); color: var(--muted); font-size: 11.5px; }
.mini-row { border-top: 1px solid var(--border); }
.rb-head { grid-template-columns: .8fr 1.3fr .8fr .8fr .8fr .7fr .9fr; }
.rf-head { grid-template-columns: .8fr 1.2fr .7fr .6fr .9fr .8fr .7fr 1.1fr; }
.refund-box { padding: 12px; margin: 10px 0; }
.refund-box h3 { font-size: 13px; margin-bottom: 8px; }
.refund-form { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.logs { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; max-height: 180px; overflow-y: auto; }
.log-line { font-size: 12px; padding: 3px 0; display: flex; gap: 8px; align-items: center; }
</style>
