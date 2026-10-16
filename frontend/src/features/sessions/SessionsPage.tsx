/**
 * 登录设备页：GET/DELETE /api/auth/sessions。
 * 列出我开着的全部登录（设备、浏览器、系统、IP、登录时间、是否记住），
 * 可以把别的设备下线、退出当前设备、或全部下线（含本机）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  listSessions,
  revokeAllSessions,
  revokeSession,
  type SessionInfo,
} from '../auth/authApi'
import { ApiRequestError } from '../../lib/http'
import { useAuth } from '../auth/authStore'
import { useToast } from '../../common/Toast'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { SkeletonBox, SkeletonButton, SkeletonChip, SkeletonText } from '../../common/Skeleton'
import LoadingRegion from '../../common/LoadingRegion'
import {
  IconRefresh,
  IconMonitor,
  IconPhone,
  IconDevices,
  IconPin,
  IconClock,
} from '../../common/icons'
import styles from './SessionsPage.module.css'

type ConfirmState =
  | { kind: 'one'; session: SessionInfo }
  | { kind: 'all'; count: number }
  | null

function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  const d = new Date(unixSeconds * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`
}

function DeviceIcon({ type, size = 20 }: { type: string; size?: number }) {
  if (type === 'mobile') return <IconPhone size={size} />
  if (type === 'desktop') return <IconMonitor size={size} />
  return <IconDevices size={size} />
}

/* 占位条高度取真实文本的行盒高度（字号 × 全局 line-height 1.6），同高才不会跳行 */
const TITLE_LINE = 22 // .deviceName 14px × 1.6 ≈ 22.4
const META_LINE = 19 // .rowMeta 12px × 1.6 ≈ 19.2
const CHIP_HEIGHT = 21 // .kindChip 11px × 1.7 加上下边框

/**
 * 骨架列表：结构与真实行逐项对齐 —— 同样是 `<ul>` / `<li>`，同样挂 `styles.row` /
 * `rowMain` / `rowTitle` / `rowMeta` / `rowAction`，行高、内边距、间距、边框因此
 * 全部由真实 CSS 决定，只有内容换成原子占位；占位条按行盒高度取，加载完切换不跳高。
 */
function SessionsListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className={styles.list} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className={styles.row} aria-hidden="true">
          {/* 40×10 对齐 .deviceIcon 的图标盒 */}
          <SkeletonBox size={40} radius={10} />
          <div className={styles.rowMain}>
            <div className={styles.rowTitle}>
              <SkeletonText width={92 + ((i * 11) % 46)} height={TITLE_LINE} />
              {/* 每行都有一个有效期胶囊；宽度取「会话有效 / 30 天有效」两种 */}
              <SkeletonChip width={i % 2 ? 62 : 78} height={CHIP_HEIGHT} />
            </div>
            <div className={styles.rowMeta}>
              <SkeletonText width={138} height={META_LINE} />
              {/* 后两项真实行里带 12px 图标（IP / 时间），占位也留出图标位 */}
              <span className={styles.metaItem}>
                <SkeletonBox size={12} radius={3} />
                <SkeletonText width={96} height={META_LINE} />
              </span>
              <span className={styles.metaItem}>
                <SkeletonBox size={12} radius={3} />
                <SkeletonText width={106} height={META_LINE} />
              </span>
            </div>
          </div>
          <div className={styles.rowAction}>
            {/* 「下线」：.btn 的 padding 16×2 + 两字文案 */}
            <SkeletonButton width={60} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function SessionsPage() {
  const navigate = useNavigate()
  const { state, dispatch } = useAuth()
  const { pushToast } = useToast()

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await listSessions()
      setSessions(data)
    } catch (err) {
      pushToast(
        'error',
        err instanceof ApiRequestError ? err.message : '登录设备加载失败',
      )
    } finally {
      setLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  /** 下线 / 退出之后的收尾：涉及本机就清会话回登录页，否则只刷列表。 */
  async function handleConfirm() {
    if (!confirm) return
    setBusy(true)
    try {
      if (confirm.kind === 'one') {
        const target = confirm.session
        await revokeSession(target.token_hash)
        if (target.current) {
          dispatch({ type: 'CLEAR' })
          pushToast('info', '已退出当前设备')
          navigate('/login', { replace: true })
          return
        }
        pushToast('success', `已让「${target.device_name || '未知设备'}」下线`)
        setConfirm(null)
        await load()
      } else {
        const { data } = await revokeAllSessions()
        dispatch({ type: 'CLEAR' })
        pushToast('info', `全部设备已下线（${data.count} 条），请重新登录`)
        navigate('/login', { replace: true })
      }
    } catch (err) {
      pushToast(
        'error',
        err instanceof ApiRequestError ? err.message : '操作失败，请重试',
      )
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  const activeCount = sessions.length

  return (
    <div className={`rise ${styles.page}`}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>登录设备</h2>
          <p className={styles.sub}>
            当前账号开着的全部登录。在别的设备忘了退出？在这里直接让它下线；
            下线后那台设备需要重新登录。
          </p>
        </div>
        <div className={styles.headActions}>
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            <IconRefresh size={15} className={loading ? styles.spinIcon : ''} />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setConfirm({ kind: 'all', count: activeCount })}
            disabled={loading || activeCount === 0}
          >
            全部下线
          </button>
        </div>
      </header>

      {/* 骨架 / 空态 / 慢加载提示由 LoadingRegion 收口（错误走 toast，不留错误块：
          这一页的操作本身就带确认弹窗，拉不到列表时给重试按钮即可） */}
      <section className={`card ${styles.listCard}`}>
        <LoadingRegion
          loading={loading}
          isEmpty={sessions.length === 0}
          onRetry={() => void load()}
          liveLabel="正在加载登录设备…"
          skeleton={<SessionsListSkeleton />}
          empty={
            <div className="state-box">
              <IconDevices size={28} className={styles.stateIcon} />
              <span>没有任何登录记录</span>
            </div>
          }
        >
        <ul className={styles.list}>
          {sessions.map((s) => (
            <li
              key={s.token_hash}
              className={`${styles.row} ${s.current ? styles.rowCurrent : ''}`}
            >
              <span className={styles.deviceIcon}>
                <DeviceIcon type={s.device_type} />
              </span>

              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <span className={styles.deviceName}>
                    {s.device_name || '未知设备'}
                  </span>
                  {s.current && <span className={`chip chip-accent ${styles.currentChip}`}>本机</span>}
                  <span className={`chip ${styles.kindChip}`}>
                    {s.remembered ? '30 天有效' : '会话有效'}
                  </span>
                </div>
                <div className={styles.rowMeta}>
                  <span>{[s.browser, s.os].filter(Boolean).join(' · ') || '未知浏览器 / 系统'}</span>
                  {s.ip && (
                    <span className={styles.metaItem}>
                      <IconPin size={12} />
                      {s.ip}
                    </span>
                  )}
                  <span className={styles.metaItem}>
                    <IconClock size={12} />
                    {formatTime(s.created_at)}
                  </span>
                </div>
              </div>

              <div className={styles.rowAction}>
                {s.current ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => setConfirm({ kind: 'one', session: s })}
                  >
                    退出登录
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirm({ kind: 'one', session: s })}
                  >
                    下线
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        </LoadingRegion>
      </section>

      <p className={styles.footNote}>
        当前这台设备：{state.deviceName || '未知设备'}。勾了「记住设备」的登录 30 天内免登录，
        其余为会话登录，关闭浏览器即失效；带令牌的请求会自动滑动续期。
      </p>

      {confirm?.kind === 'one' && (
        <ConfirmDialog
          title={confirm.session.current ? '退出当前设备？' : '让这台设备下线？'}
          body={
            confirm.session.current ? (
              <>
                将注销 <b>{confirm.session.device_name || '当前设备'}</b> 上的登录并返回登录页。
                其他设备不受影响。
              </>
            ) : (
              <>
                <b>{confirm.session.device_name || '未知设备'}</b>
                {confirm.session.ip ? `（${confirm.session.ip}）` : ''}
                上的登录会被立刻吊销，它需要重新登录。
              </>
            )
          }
          confirmText={confirm.session.current ? '退出登录' : '让它下线'}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void handleConfirm()}
        />
      )}
      {confirm?.kind === 'all' && (
        <ConfirmDialog
          title="全部设备下线？"
          body={
            <>
              将吊销全部 <b>{confirm.count}</b> 条登录，<b>包含当前这台</b>
              ，操作后需要重新登录。此操作不可撤销。
            </>
          }
          confirmText={`全部下线（${confirm.count}）`}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void handleConfirm()}
        />
      )}
    </div>
  )
}
