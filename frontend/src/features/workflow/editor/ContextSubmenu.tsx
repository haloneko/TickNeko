/** 单个二级菜单外框，分类变化只替换文字层；交互与动效见 docs/workflow/workflow.md。 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { nodeDef, type NodeTypeSpec } from './catalog'
import { CONTEXT_MENU_EXIT_MS, deferMenuRemoval } from './menuMotion'
import { placeSubmenu, type SubmenuBounds } from './submenuMotion'
import styles from '../WorkflowEditor.module.css'

export interface ActiveSubmenu {
  id: string
  specs: NodeTypeSpec[]
  anchor: HTMLElement
  main: HTMLElement
}

interface Props {
  active: ActiveSubmenu | null
  leaving: boolean
  onPick: (type: string) => void
}

export function ContextSubmenu({ active, leaving, onPick }: Props) {
  const [retained, setRetained] = useState<ActiveSubmenu | null>(null)
  const [outgoing, setOutgoing] = useState<ActiveSubmenu | null>(null)
  const [closing, setClosing] = useState(false)
  const [bounds, setBounds] = useState<SubmenuBounds | null>(null)
  const previous = useRef<ActiveSubmenu | null>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!active || leaving) {
      if (!previous.current) return
      setClosing(true)
      return deferMenuRemoval(() => {
        previous.current = null
        setRetained(null)
        setOutgoing(null)
      }, window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    }
    const old = previous.current
    setOutgoing(old && old.id !== active.id ? old : null)
    previous.current = active
    setRetained(active)
    setClosing(false)
    const place = () => {
      const measure = measureRef.current
      if (!measure) return
      const next = placeSubmenu(active.anchor.getBoundingClientRect(), active.main.getBoundingClientRect(),
        measure.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })
      setBounds(last => last && Object.keys(next).every(key => next[key as keyof SubmenuBounds] === last[key as keyof SubmenuBounds]) ? last : next)
    }
    place()
    const observer = new ResizeObserver(place)
    if (measureRef.current) observer.observe(measureRef.current)
    window.addEventListener('resize', place)
    const timer = window.setTimeout(() => setOutgoing(null), 120)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.clearTimeout(timer)
    }
  }, [active, leaving])

  useLayoutEffect(() => {
    shellRef.current?.toggleAttribute('inert', closing || leaving)
  }, [closing, leaving, retained])

  const measured = active ?? retained
  const items = (entry: ActiveSubmenu, disabled: boolean) => entry.specs.map(spec => {
    const def = nodeDef(spec.type)
    return <button key={spec.type} className={styles.ctxMenuItem} role="menuitem" title={def.label}
      disabled={disabled} tabIndex={disabled ? -1 : undefined} onClick={() => onPick(spec.type)}>
      <span className={styles.ctxDot} style={{ background: def.color }} />{def.label}
    </button>
  })

  return <>
    {measured && <div ref={measureRef} data-context-submenu="measure" className={styles.ctxSubMeasure} aria-hidden="true">
      {items(measured, true)}
    </div>}
    {retained && bounds && <div ref={shellRef} className={styles.ctxSubMenu} data-context-submenu="shell"
      data-phase={closing || leaving ? 'leaving' : 'open'} data-side={bounds.side}
      aria-hidden={closing || leaving || undefined} role="menu"
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
        '--ctx-sub-text-x': bounds.side === 'right' ? '-8px' : '8px',
        '--ctx-exit-duration': `${CONTEXT_MENU_EXIT_MS}ms`,
      } as CSSProperties}>
      <div className={styles.ctxSubViewport}>
        {outgoing && <div key={outgoing.id} className={`${styles.ctxSubPane} ${styles.ctxSubPaneOut}`} aria-hidden="true">
          {items(outgoing, true)}
        </div>}
        <div key={retained.id} className={`${styles.ctxSubPane} ${styles.ctxSubPaneIn}`}>
          {items(retained, closing || leaving)}
        </div>
      </div>
    </div>}
  </>
}
