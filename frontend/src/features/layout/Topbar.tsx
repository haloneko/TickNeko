/**
 * 顶栏：
 * - 左侧：小屏汉堡（开抽屉）/ 桌面折叠按钮（收侧栏）+ 当前页面标题；
 * - 右侧：主题切换 + 用户菜单；显隐、交互与动效见 docs/console/layout.md。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { NAV_ITEMS } from './nav'
import { useLayout } from './layoutStore'
import { useAuth } from '../auth/authStore'
import { revokeSession } from '../auth/authApi'
import AvatarImage from '../auth/AvatarImage'
import { ThemeToggle } from '../../common/theme'
import {
  IconMenu,
  IconCollapse,
  IconExpand,
  IconChevronDown,
  IconLogout,
  IconDevices,
  IconSettings,
} from '../../common/icons'
import styles from './Topbar.module.css'

export default function Topbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { state, dispatch } = useAuth()
  const { collapsed, toggleCollapsed, toggleMobile } = useLayout()
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const menuId = useId()
  const userWrapRef = useRef<HTMLDivElement>(null)
  const userButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    menu.toggleAttribute('inert', !menuOpen)
    if (menuOpen) {
      menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    } else if (menu.contains(menu.ownerDocument.activeElement)) {
      userButtonRef.current?.focus({ preventScroll: true })
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !userWrapRef.current?.contains(event.target)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMenuOpen(false)
      userButtonRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => setMenuOpen(false), [location.key])

  const current =
    NAV_ITEMS.find((i) =>
      i.end ? location.pathname === i.path : location.pathname.startsWith(i.path),
    ) ?? NAV_ITEMS[0]

  const user = state.user
  const initial = (user?.nickname || user?.account || '?').slice(0, 1)

  async function logout() {
    // 调吊销接口让服务端会话失效（会顺带清 HttpOnly Cookie）；接口失败也照常本地清退，
    // 避免「网络抖一下就退不出去」。
    setMenuOpen(false)
    setLoggingOut(true)
    try {
      if (state.tokenHash) {
        await revokeSession(state.tokenHash)
      }
    } catch {
      /* 服务端没吊销成功（已过期 / 网络问题）也不拦本地退出 */
    } finally {
      setLoggingOut(false)
      dispatch({ type: 'CLEAR' })
      navigate('/login', { replace: true })
    }
  }

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        {/* 小屏汉堡 */}
        <button
          className={`icon-btn ${styles.menuBtn}`}
          onClick={toggleMobile}
          aria-label="打开导航"
        >
          <IconMenu size={20} />
        </button>
        {/* 桌面折叠 */}
        <button
          className={`icon-btn ${styles.collapseBtn}`}
          onClick={toggleCollapsed}
          aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
          title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
        >
          {collapsed ? <IconExpand size={19} /> : <IconCollapse size={19} />}
        </button>

        <h1 className={styles.title}>{current.label}</h1>
      </div>

      <div className={styles.right}>
        <ThemeToggle />

        <div ref={userWrapRef} className={styles.userWrap}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false)
          }}>
          <button
            ref={userButtonRef}
            className={styles.userBtn}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setMenuOpen(true)
              }
            }}
          >
            <AvatarImage initial={initial} size="sm" />
            <span className={styles.userMeta}>
              <span className={styles.userName}>
                {user?.nickname || user?.account}
              </span>
            </span>
            <IconChevronDown size={15} className={styles.caret} />
          </button>

              <div ref={menuRef} id={menuId} className={styles.menu} role="menu"
                aria-label="账号菜单" aria-hidden={!menuOpen || undefined} data-open={menuOpen}
                onKeyDown={event => {
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
                  if (!items.length) return
                  const currentIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLElement)
                  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (currentIndex + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
                  items[index].focus({ preventScroll: true })
                }}>
                <div className={styles.menuHead}>
                  <AvatarImage initial={initial} size="md" />
                  <div className={styles.menuUser}>
                    <span className={styles.menuName}>
                      {user?.nickname || '未命名'}
                    </span>
                    <span className={styles.menuAccount}>@{user?.account}</span>
                  </div>
                </div>
                {user && user.roles.length > 0 && (
                  <div className={styles.menuRoles}>
                    {user.roles.map((r) => (
                      <span key={r} className={`chip ${r === 'admin' ? 'chip-accent' : ''}`}>
                        {r}
                      </span>
                    ))}
                  </div>
                )}
                <div className={styles.menuDivider} />
                <Link
                  to="/profile"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  <IconSettings size={17} />
                  个人设置
                </Link>
                <Link
                  to="/sessions"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  <IconDevices size={17} />
                  登录设备
                </Link>
                <button
                  className={styles.logoutBtn}
                  onClick={() => void logout()}
                  role="menuitem"
                  disabled={loggingOut}
                >
                  <IconLogout size={17} />
                  {loggingOut ? '正在退出…' : '退出登录'}
                </button>
              </div>
        </div>
      </div>
    </header>
  )
}
