/**
 * CodeMirror 6 编辑器：行号、折叠、括号匹配、实时 lint。
 *
 * 两种模式：
 * * ``json``：JSON 语法高亮 + 实时 lint（无效时打字的瞬间就标出波浪线与沟槽标记，
 *   而不是保存时才报错），并提供 format() 格式化。
 * * ``text``：纯文本 + 行号，无语法高亮 / lint / 格式化 —— 给 str 变量这类
 *   「只是没有专门编辑选项」的文本用，保持与其他类型一致的编辑器体验。
 *
 * 用法：
 *     const ref = useRef<JsonEditorHandle>(null)
 *     <JsonEditor ref={ref} value={text} onChange={setText} ariaLabel="变量 JSON" />
 *     ref.current?.format()  // 格式化重排；内容无效时不改，lint 已标出问题
 *
 * 为什么用 CodeMirror 而不是裸 textarea：变量编辑器里 JSON 是高频内容，
 * 大结构需要整体看清、随时校验，裸 textarea 只能靠保存时的一次性报错。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { linter, lintGutter } from '@codemirror/lint'
import styles from './JsonEditor.module.css'

export interface JsonEditorHandle {
  /** 格式化重排当前内容；无效 JSON 不改内容（lint 会标出问题位置）。text 模式下为空操作 */
  format: () => void
}

interface JsonEditorProps {
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  /** 编辑器最小高度（px），默认 220 */
  minHeight?: number
  /** 编辑模式：json = 语法高亮 + lint + 格式化；text = 纯文本 + 行号（无这些选项）。默认 json */
  mode?: 'json' | 'text'
}

export const JsonEditor = forwardRef<JsonEditorHandle, JsonEditorProps>(
  function JsonEditor({ value, onChange, ariaLabel, minHeight, mode = 'json' }, ref) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    // 用 ref 保最新回调，编辑器实例只建一次，不随 onChange 重建
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    // 模式只在首次挂载决定：str / json 是不同实例，挂载后不会切换
    const modeRef = useRef(mode)
    modeRef.current = mode

    useEffect(() => {
      if (!hostRef.current) return
      const isText = modeRef.current === 'text'
      const view = new EditorView({
        parent: hostRef.current,
        doc: value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          ...(isText ? [] : [lintGutter(), linter(jsonParseLinter()), json()]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { minHeight: `${minHeight ?? 220}px` },
            '.cm-scroller': {
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
              fontSize: '13px',
              lineHeight: '1.55',
            },
          }),
        ],
      })
      viewRef.current = view
      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [])

    // 外部 value 变化（格式化、从视图切换回来）时同步进编辑器；本地刚打的字不覆盖
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (current !== value) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
      }
    }, [value])

    useImperativeHandle(ref, () => ({
      format() {
        const view = viewRef.current
        if (!view || modeRef.current !== 'json') return
        const text = view.state.doc.toString()
        try {
          const pretty = JSON.stringify(JSON.parse(text), null, 2) ?? 'null'
          if (pretty !== text) {
            view.dispatch({ changes: { from: 0, to: text.length, insert: pretty } })
          }
        } catch {
          // 无效 JSON：不动内容，lint 已标出问题
        }
      },
    }))

    return (
      <div className={styles.editor} aria-label={ariaLabel}>
        <div ref={hostRef} className={styles.host} />
      </div>
    )
  },
)

export default JsonEditor
