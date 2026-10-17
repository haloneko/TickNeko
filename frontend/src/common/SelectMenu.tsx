/**
 * 通用下拉选择：框 + 门户菜单，替代原生 select。
 * 复杂度 O(n)，n = 选项数；开合各一次测量 + 一次渲染。
 * button 触发器：原生 select 箭头动不了，也拿不到展开态。键盘自理（↑↓ Home End Enter Space Esc Tab）。
 * 菜单挂 body：.panel 是 overflow:hidden，就地定位会被裁。宽度 = 触发器，长选项菜单内省略。
 * 档位由调用方给，OwnerFilter 是最小示例。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown } from './icons'
import styles from './SelectMenu.module.css'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectMenuProps {
  options: SelectOption[]
  /** 选中值 */
  value: string
  onChange: (value: string) => void
  /** 字段名：横向在左、纵向在上；不传不画 */
  label?: string
  /** 读屏名，缺省回落 label */
  ariaLabel?: string
  /** horizontal 字段名在左（默认）/ vertical 在上 */
  layout?: 'horizontal' | 'vertical'
  /** 挂根节点，调宽距 */
  className?: string
}

/** 触发器与菜单间距 */
const MENU_GAP = 6
/** 菜单离视口边缘 */
const VIEWPORT_MARGIN = 8
/** 下方窄于此则考虑朝上 */
const MIN_SPACE_BELOW = 180

/** 菜单落点：宽度恒等触发器，上下挑宽裕侧。 */
interface MenuBox {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
}

export default function SelectMenu({
  options,
  value,
  onChange,
  label,
  ariaLabel,
  layout = 'horizontal',
  className,
}: SelectMenuProps) {
  // option id 每实例唯一（同页多个下拉）
  const groupId = useId()
  const [open, setOpen] = useState(false)
  /** 键盘高亮档位；鼠标移入也改它 */
  const [active, setActive] = useState(0)
  const [box, setBox] = useState<MenuBox | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)

  // 展开后焦点交给 listbox，按键走 aria-activedescendant
  useEffect(() => {
    if (open) menuRef.current?.focus()
  }, [open])

  // 点外面 / Esc / 滚动 / resize → 收起
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    const onScroll = (event: Event) => {
      // 菜单自身滚动不算页面动
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const vertical = layout === 'vertical'
  // 选中档可能已不在清单，显示原值
  const current = options.find((opt) => opt.value === value)
  const currentLabel = current?.label ?? value
  const name = ariaLabel ?? label

  /** 量触发器视口位置：宽度同框、左对齐、上下挑宽裕侧 */
  function measure(): MenuBox | null {
    const trigger = triggerRef.current
    if (!trigger) return null
    const rect = trigger.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN
    const above = rect.top - MENU_GAP - VIEWPORT_MARGIN
    // 上面更宽裕 → 朝上开（bottom 定位，免量高度）
    const up = below < MIN_SPACE_BELOW && above > below
    // 框贴右时回收到视口内
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    return {
      left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft),
      top: up ? undefined : rect.bottom + MENU_GAP,
      bottom: up ? window.innerHeight - rect.top + MENU_GAP : undefined,
      width: rect.width,
      maxHeight: Math.max(140, up ? above : below),
    }
  }

  function openMenu(edge: 'selected' | 'first' | 'last' = 'selected') {
    const selected = options.findIndex((opt) => opt.value === value)
    setActive(edge === 'last' ? options.length - 1 : edge === 'first' ? 0 : Math.max(selected, 0))
    setBox(measure())
    setOpen(true)
  }

  function closeMenu(refocus = true) {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  function commit(next: string) {
    onChange(next)
    closeMenu()
  }

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const last = options.length - 1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((i) => (i >= last ? 0 : i + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((i) => (i <= 0 ? last : i - 1))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(last)
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const target = options[active] ?? options[0]
        if (target) commit(target.value)
        break
      }
      case 'Escape':
        event.preventDefault()
        closeMenu()
        break
      case 'Tab':
        // 门户在 body 尾，自然 Tab 跳到浏览器 chrome
        event.preventDefault()
        closeMenu()
        break
      default:
        break
    }
  }

  return (
    <div
      className={[vertical ? styles.wrapVertical : styles.wrap, className]
        .filter(Boolean)
        .join(' ')}
    >
      {label && (
        <span className={vertical ? styles.labelVertical : styles.label}>{label}</span>
      )}
      <div ref={rootRef} className={vertical ? styles.dropdownVertical : styles.dropdown}>
        <button
          ref={triggerRef}
          type="button"
          className={vertical ? styles.triggerVertical : styles.trigger}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={name ? `${name}：${currentLabel}` : currentLabel}
          onClick={() => (open ? closeMenu(false) : openMenu())}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            openMenu(event.key === 'ArrowDown' ? 'selected' : 'last')
          }}
        >
          <span className={styles.triggerValue}>{currentLabel}</span>
          <IconChevronDown size={14} className={styles.caret} />
        </button>

        {open &&
          box &&
          createPortal(
            <ul
              ref={menuRef}
              className={styles.menu}
              role="listbox"
              aria-label={name}
              tabIndex={-1}
              aria-activedescendant={`${groupId}-${active}`}
              style={{
                left: box.left,
                top: box.top,
                bottom: box.bottom,
                width: box.width,
                maxHeight: box.maxHeight,
              }}
              onKeyDown={onMenuKeyDown}
            >
              {options.map((opt, index) => {
                const selected = opt.value === value
                // 菜单同宽 → 长文案省略，title 补全
                return (
                  <li
                    key={opt.value}
                    id={`${groupId}-${index}`}
                    role="option"
                    aria-selected={selected}
                    title={opt.label}
                    className={[
                      styles.option,
                      index === active ? styles.optionActive : '',
                      selected ? styles.optionSelected : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(opt.value)}
                  >
                    <span className={styles.optionLabel}>{opt.label}</span>
                    {selected && <IconCheck size={14} className={styles.optionCheck} />}
                  </li>
                )
              })}
            </ul>,
            document.body,
          )}
      </div>
    </div>
  )
}
