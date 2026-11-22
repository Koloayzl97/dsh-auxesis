// dsh-auxesis — 设置页（浏览器侧）
// 勾选本机已配置的 provider/model 路由；保存后立即生效（下一次工具调用按新勾选校验）。
window.__ModuleLoader__.load({
  id: 'dsh-auxesis',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const box = { border: '1px solid var(--dsh-border, rgba(127,127,127,.28))', borderRadius: 10, padding: '10px 12px' }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13 }
    const muted = { opacity: 0.7, fontSize: 12, lineHeight: 1.6 }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [picked, setPicked] = React.useState(() => new Set())
      const [def, setDef] = React.useState('')
      const [fb, setFb] = React.useState('')
      const [effort, setEffort] = React.useState('')
      const [maxTok, setMaxTok] = React.useState('')
      const [deadline, setDeadline] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const apply = (j) => {
        setState(j)
        setPicked(new Set((j && j.settings && j.settings.selected) || []))
        setDef((j && j.settings && j.settings.defaultRoute) || '')
        setFb((j && j.settings && j.settings.fallbackRoute) || '')
        setEffort((j && j.settings && j.settings.reasoningEffort) || '')
        setMaxTok(String((j && j.settings && j.settings.maxTokens) || ''))
        setDeadline(String((j && j.settings && j.settings.deadlineMs) || ''))
      }

      const load = React.useCallback(async () => {
        setMsg('读取中…')
        const res = await fetch('/dsh-auxesis/state', { headers: { accept: 'application/json' } })
        const json = await res.json()
        if (!json || !json.ok) throw new Error((json && json.error) || '读取失败')
        apply(json)
        setMsg('')
      }, [])

      React.useEffect(() => {
        load().catch((e) => setMsg('读取失败：' + ((e && e.message) || e)))
      }, [load])

      const toggle = (route) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(route)) next.delete(route)
          else next.add(route)
          if (!next.has(route)) setDef((cur) => (cur === route ? '' : cur))
          return next
        })
        setMsg('')
      }

      const save = async () => {
        setBusy(true)
        setMsg('保存中…')
        try {
          // 按目录顺序提交，而不是点击顺序：这样「第一条」= 列表里的第一条，行为可预期
          const ordered = providers
            .flatMap((p) => (p.models || []).map((m) => p.id + '/' + m.id))
            .filter((r) => picked.has(r))
          const res = await fetch('/dsh-auxesis/select', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              selected: ordered,
              default: def,
              fallbackRoute: fb,
              reasoningEffort: effort,
              maxTokens: Number(maxTok) || undefined,
              deadlineMs: Number(deadline) || undefined,
            }),
          })
          const json = await res.json()
          if (!json || !json.ok) throw new Error((json && json.error) || '保存失败')
          apply({ ...state, settings: json.settings })
          setMsg('已保存：' + (json.settings.selected.length || 0) + ' 条路由可用')
        } catch (e) {
          setMsg('保存失败：' + ((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (!state) {
        return h('div', { style: { padding: 4, fontSize: 13 } }, msg || '读取中…')
      }

      const providers = Array.isArray(state.providers) ? state.providers : []
      const total = providers.reduce((n, p) => n + (Array.isArray(p.models) ? p.models.length : 0), 0)
      const orderedSelected = providers
        .flatMap((p) => (p.models || []).map((m) => p.id + '/' + m.id))
        .filter((r) => picked.has(r))

      // 搜索：provider 名/id 命中就展开它的全部模型；否则只留模型名/id 命中的行。
      // 隐藏项不影响已勾选状态 —— 搜索只是过滤器。
      const q = query.trim().toLowerCase()
      const filtered = providers
        .map((p) => {
          const pText = (p.id + ' ' + (p.name || '')).toLowerCase()
          const models = (p.models || []).filter((m) => !q
            || pText.includes(q)
            || (m.id + ' ' + (m.name || '')).toLowerCase().includes(q))
          return { p, models, show: !q || pText.includes(q) || models.length > 0 }
        })
        .filter((x) => x.show)
      const visibleCount = filtered.reduce((n, x) => n + x.models.length, 0)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: muted },
          '勾选允许被「Auxesis」使用的模型路由。模型遇到需要从目标倒推的复杂问题时，会调用 auxesis，从这些路由里选一条；没勾的不会被用到。',
          h('br'),
          '共 ' + total + ' 个模型，已勾选 ' + picked.size + ' 条。',
        ),
        h('input', {
          type: 'search',
          value: query,
          placeholder: '搜索模型或 provider，例如 claude-opus-5-5',
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Escape') setQuery('') },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 10px',
            borderRadius: 8,
            border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
            background: 'transparent',
            color: 'inherit',
            fontSize: 13,
          },
        }),
        h('div', { style: muted }, q ? ('匹配 ' + visibleCount + ' 个模型') : ''),
        providers.length === 0
          ? h('div', { style: { ...box, ...muted } }, '本机没有已配置的模型路由。先在设置 → 模型里加一条 provider，再回来勾选。')
          : h('div', { style: { ...box, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflow: 'auto' } },
              filtered.length === 0
                ? h('div', { style: muted }, '没有匹配「' + query + '」的模型。')
                : filtered.map(({ p, models }) => h('div', { key: p.id },
                h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } },
                  (p.name || p.id),
                  h('span', { style: { ...muted, marginLeft: 6 } }, p.id),
                ),
                models.length === 0
                  ? h('div', { style: muted }, '这个 provider 没有公布模型。')
                  : models.map((m) => {
                      const route = p.id + '/' + m.id
                      return h('label', { key: route, style: rowStyle },
                        h('input', {
                          type: 'checkbox',
                          checked: picked.has(route),
                          onChange: () => toggle(route),
                        }),
                        h('span', null, m.name || m.id),
                        h('span', { style: muted }, route),
                        picked.has(route)
                          ? h('span', {
                              style: { ...muted, display: 'inline-flex', alignItems: 'center', gap: 10, marginLeft: 'auto' },
                            },
                              h('span', {
                                style: { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' },
                                title: '默认路由：模型省略 route 时用它',
                                onClick: (e) => { e.preventDefault(); e.stopPropagation(); setDef(route) },
                              },
                                h('input', {
                                  type: 'radio',
                                  name: 'dsh-auxesis-default',
                                  checked: def ? def === route : orderedSelected[0] === route,
                                  onChange: () => setDef(route),
                                  onClick: (e) => e.stopPropagation(),
                                }),
                                '默认',
                              ),
                              h('span', {
                                style: { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' },
                                title: '备选路由：默认路由失败后自动改用它（内容过滤/超时不重试，直接切换）',
                                onClick: (e) => { e.preventDefault(); e.stopPropagation(); setFb((cur) => (cur === route ? '' : route)) },
                              },
                                h('input', {
                                  type: 'radio',
                                  name: 'dsh-auxesis-fallback',
                                  checked: fb === route,
                                  onChange: () => setFb(route),
                                  onClick: (e) => e.stopPropagation(),
                                }),
                                '备选',
                              ),
                            )
                          : null,
                      )
                    }),
              )),
            ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
          h('span', null, '推理强度'),
          h('select', { value: effort, onChange: (e) => setEffort(e.target.value) },
            ['', 'off', 'low', 'medium', 'high', 'max'].map((v) => h('option', { key: v, value: v },
              v === '' ? '不指定（交给路由自己决定）' : v)),
          ),
          h('span', { style: muted }, '留空 = 模型自己判断要不要深想；填了就是强制。'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
          h('span', null, '输出预算'),
          h('input', {
            type: 'number', min: 256, max: 64000, step: 1024, value: maxTok,
            onChange: (e) => setMaxTok(e.target.value),
            style: { width: 96, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit' },
          }),
          h('span', { style: muted }, 'token（上限，不是预付；截断才是浪费）'),
          h('span', { style: { marginLeft: 12 } }, '超时'),
          h('input', {
            type: 'number', min: 5000, max: 900000, step: 10000, value: deadline,
            onChange: (e) => setDeadline(e.target.value),
            style: { width: 104, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit' },
          }),
          h('span', { style: muted }, 'ms'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { type: 'button', disabled: busy, onClick: save }, busy ? '保存中…' : '保存勾选'),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => { setPicked(new Set()); setMsg('') },
          }, '全部取消'),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => {
              const all = new Set()
              for (const p of providers) for (const m of (p.models || [])) all.add(p.id + '/' + m.id)
              setPicked(all)
              setMsg('')
            },
          }, '全选'),
        ),
        msg ? h('div', { style: { ...muted, opacity: 0.85 } }, msg) : null,
        h('div', { style: muted },
          '默认路由：' + ((def && picked.has(def)) ? def : (orderedSelected[0] || '（未勾选）')) + '。模型省略 route 时用它 —— 点某条右侧的「默认」可以改。',
          h('br'),
          '备选路由：' + (fb && picked.has(fb) ? fb : '（未设）') + '。默认路由失败后自动改用它（内容过滤/超时不重试，直接切），结果里会标 fellBackFrom。',
          h('br'),
          '保存后不需要重启：工具调用时按最新勾选校验。',
        ),
      )
    }

    // 校验图标：放大镜（内联 SVG，不依赖字体）
    function VerifyIcon() {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        style: { display: 'block' },
      },
        h('circle', { cx: 7, cy: 7, r: 4.2 }),
        h('path', { d: 'M10.2 10.2L14 14' }),
      )
    }

    // ── 发送栏「复核」按钮：备注可空，空则复核上一条回答
    function CorrectChip() {
      const [open, setOpen] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [state, setState] = React.useState('idle')
      const [msg, setMsg] = React.useState('')
      const [picked, setPicked] = React.useState([])
      const [scope, setScope] = React.useState('recent')
      const [anchored, setAnchored] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      React.useEffect(() => {
        const measure = () => {
          const el = document.querySelector('[data-aux-verify]')
          if (!el) return null
          const r = el.getBoundingClientRect()
          if (!r.width) return null
          return { right: Math.max(8, window.innerWidth - r.right), bottom: Math.max(8, window.innerHeight - r.top + 8) }
        }
        const onOpen = () => {
          setAnchor(measure())
          // 再点一次同一个按钮要能收起，所以是切换而不是只开
          setOpen((v) => !v)
          setAnchored(Boolean(window.__dshAuxAnchored))
        }
        const onAnchor = () => setAnchored(Boolean(window.__dshAuxAnchored))
        const onDocDown = (e) => {
          const t = e.target
          if (t && (t.closest && (t.closest('[data-aux-panel]') || t.closest('[data-aux-verify]')))) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDocDown, true)
        window.addEventListener('dsh-auxesis:verify', onOpen)
        window.addEventListener('dsh-auxesis:anchored', onAnchor)
        onAnchor()
        return () => {
          window.removeEventListener('dsh-auxesis:verify', onOpen)
          document.removeEventListener('mousedown', onDocDown, true)
          window.removeEventListener('dsh-auxesis:anchored', onAnchor)
        }
      }, [])
      const CHIPS = [
        ['方向错了', '我觉得方向跑偏了：'],
        ['证据不足', '你给的结论没有依据，先把证据拿出来：'],
        ['别再动它', '不要再改这个文件 / 这个配置：'],
        ['更保守', '换一个更保守、可回滚的做法：'],
      ]

      const submit = async () => {
        if (state === 'running') return
        setState('running')
        setMsg('检查中…（约 15–30 秒）')
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 120000)
        try {
          const res = await fetch('/dsh-auxesis/correct', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              note: (picked.map((k) => (CHIPS.find((c) => c[0] === k) || [])[1] || '').join(' ') + ' ' + note).trim() || undefined,
              scope,
            }),
            signal: ctl.signal,
          })
          const j = await res.json()
          if (!j || !j.ok) throw new Error((j && (j.message || j.error)) || '复核失败')
          const v = j.verdict || {}
          const delivered = j.delivered || 'skipped'
          const tail = delivered === 'followup' ? '，已拉起主模型改向'
            : delivered === 'busy' ? '（模型正忙，结论未送达）'
              : delivered === 'error' ? '（回流失败：' + (j.followupError || '未知') + '）'
                : '（未回流）'
          setState('done')
          setMsg((v.verdict === 'turn' ? '方向跑偏：' + (v.correct_next || '见结论') : '方向基本正确') + tail)
          setNote('')
          setTimeout(() => { setOpen(false); setState('idle'); setMsg('') }, 8000)
        } catch (e) {
          setState('error')
          setMsg(e && e.name === 'AbortError'
            ? '超时（120s）：插件可能卡在上游，详见 events.jsonl'
            : String((e && e.message) || e))
        } finally {
          clearTimeout(timer)
        }
      }

      const tone = state === 'error' ? '#e5484d' : state === 'done' ? '#30a46c' : 'inherit'

      // 入口已经在输入框里了：收起时不占任何布局空间（连 2px margin 都不要）
      if (anchored && !open) return null

      return h('div', {
        // 注入模式下这个容器本身不能占位：fixed + 零尺寸，面板自己再 fixed 定位
        style: anchored
          ? { position: 'fixed', top: 0, left: 0, width: 0, height: 0, margin: 0, padding: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 40 }
          : { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, margin: '2px auto', maxWidth: 560, width: '100%' },
      },
        msg ? h('span', { style: { fontSize: 11, opacity: 0.8, color: tone, marginRight: 'auto' } }, msg) : null,
        anchored ? null : h('button', {
          type: 'button',
          className: 'aux-toggle',
          'data-on': open ? '1' : '0',
          onClick: () => { setOpen((v) => !v); setMsg('') },
          title: '校验：把会话里说过的话和盘上现在的事实，交给 auxesis 外部核一遍',
          style: {
            width: 22, height: 22, padding: 0, borderRadius: 6, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, border: '1px solid var(--dsh-border, rgba(127,127,127,.25))',
            background: 'transparent', color: 'inherit', opacity: open ? 1 : 0.45,
          },
        }, '◈'),
        open
          ? h('div', {
              'data-aux-panel': '1',
              style: {
                position: 'fixed',
                right: (anchor ? anchor.right : 16) + 'px',
                bottom: (anchor ? anchor.bottom : 120) + 'px',
                zIndex: 40, width: 340, pointerEvents: 'auto',
                display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px',
                border: '1px solid var(--dsh-border, rgba(127,127,127,.3))', borderRadius: 12,
                background: 'var(--dsh-surface, #1b1b1e)', color: 'inherit',
                boxShadow: '0 8px 28px rgba(0,0,0,.35)',
              },
            },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                CHIPS.map(([label, fill]) => {
                  const on = picked.includes(label)
                  return h('button', {
                    key: label, type: 'button',
                    onClick: () => setPicked((cur) => (on ? cur.filter((x) => x !== label) : [...cur, label])),
                    style: {
                      fontSize: 11, padding: '2px 9px', borderRadius: 999, cursor: 'pointer',
                      border: '1px solid ' + (on ? 'var(--dsh-accent, #6e9ef2)' : 'var(--dsh-border, rgba(127,127,127,.3))'),
                      background: on ? 'var(--dsh-accent-soft, rgba(110,158,242,.14))' : 'transparent',
                      color: 'inherit', opacity: on ? 1 : 0.75,
                    },
                  }, label)
                }),
              ),
              h('textarea', {
                value: note,
                rows: 2,
                placeholder: '可选：用一句话说清哪里不对（Enter 发起，Shift+Enter 换行）',
                onChange: (e) => setNote(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Escape') { setOpen(false); setMsg('') }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
                },
                style: {
                  width: '100%', boxSizing: 'border-box', resize: 'vertical',
                  padding: '6px 10px', borderRadius: 8, fontSize: 12, lineHeight: '18px',
                  border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
                  background: 'transparent', color: 'inherit', fontFamily: 'inherit',
                },
              }),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.75 } },
                h('span', null, '范围'),
                h('button', {
                  type: 'button', onClick: () => setScope('recent'),
                  style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, cursor: 'pointer',
                    border: '1px solid ' + (scope === 'recent' ? 'var(--dsh-accent, #6e9ef2)' : 'var(--dsh-border, rgba(127,127,127,.3))'),
                    background: 'transparent', color: 'inherit', opacity: scope === 'recent' ? 1 : 0.6 },
                }, '最近'),
                h('button', {
                  type: 'button', onClick: () => setScope('all'),
                  style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, cursor: 'pointer',
                    border: '1px solid ' + (scope === 'all' ? 'var(--dsh-accent, #6e9ef2)' : 'var(--dsh-border, rgba(127,127,127,.3))'),
                    background: 'transparent', color: 'inherit', opacity: scope === 'all' ? 1 : 0.6 },
                }, '全段'),
                h('span', { style: { flex: 1 } }),
                h('button', { type: 'button', disabled: state === 'running', onClick: submit },
                  state === 'running' ? '校验中…' : '发起'),
              ),
            )
          : null,
      )
    }

    // ── 发送栏开关：自动决策。开着时可逆决策不问用户，模型直接调 auxesis 拿结论并执行。
    function AutoDecideChip() {
      const [on, setOn] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        fetch('/dsh-auxesis/state', { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((j) => { if (alive && j && j.ok) setOn(Boolean(j.settings && j.settings.autoDecide)) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      const toggle = async () => {
        if (busy || on === null) return
        setBusy(true)
        try {
          const res = await fetch('/dsh-auxesis/auto', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ autoDecide: !on }),
          })
          const j = await res.json()
          if (j && j.ok) setOn(Boolean(j.autoDecide))
        } catch {
          // 失败保持原状，下一轮再点
        } finally {
          setBusy(false)
        }
      }

      const onColor = '#30a46c'
      return h('button', {
        type: 'button',
        className: 'aux-toggle',
        'data-on': on ? '1' : '0',
        onClick: toggle,
        disabled: busy || on === null,
        title: on
          ? '自动决策：开。可逆的选型/取舍/优先级不再问用户，直接调 auxesis 拿结论并执行；不可逆动作、偏好与凭据、置信不足仍会问。点击关闭。'
          : '自动决策：关。点击开启后，可逆的决策不再询问用户，模型直接调 auxesis 拿结论并执行。',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, lineHeight: '18px',
          padding: '3px 10px 3px 8px', borderRadius: 999, margin: '2px auto',
          cursor: on === null ? 'default' : 'pointer',
          border: '1px solid ' + (on ? 'rgba(48,164,108,.42)' : 'var(--dsh-border, rgba(127,127,127,.3))'),
          color: 'inherit',
          opacity: busy ? 0.5 : (on === null ? 0.45 : (on ? 0.95 : 0.66)),
          userSelect: 'none',
        },
      },
        // 微轨滑块：状态靠位置与颜色表达，不再用「开/关」两个字
        h('span', {
          style: {
            width: 20, height: 11, borderRadius: 999, position: 'relative', flex: '0 0 auto',
            background: on ? 'rgba(48,164,108,.5)' : 'rgba(127,127,127,.26)',
            transition: 'background .18s ease',
          },
        },
          h('span', {
            style: {
              position: 'absolute', top: 1, left: on ? 10 : 1, width: 9, height: 9,
              borderRadius: 999,
              background: on ? onColor : 'rgba(127,127,127,.7)',
              transition: 'left .18s ease, background .18s ease',
            },
          }),
        ),
        h('span', { style: { fontWeight: 600, letterSpacing: 0.2 } }, '自动决策'),
      )
    }

    // ── 主界面状态条：轮询 /dsh-auxesis/status，显示存活、默认路由与调用次数
    const ACCENT = '#7aa2f7'

    function StatusChip() {
      const [st, setSt] = React.useState(null)
      const [down, setDown] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const res = await fetch('/dsh-auxesis/status', { headers: { accept: 'application/json' } })
            const json = await res.json()
            if (!alive) return
            if (json && json.ok) { setSt(json); setDown(false) } else { setDown(true); setSt(null) }
          } catch {
            if (alive) { setDown(true); setSt(null) }
          }
        }
        tick()
        const timer = setInterval(tick, 20000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const model = st ? String(st.route || '').split('/').pop() : ''
      const color = down ? '#e5484d' : st && st.routeExists ? '#30a46c' : '#f5a524'
      const state = down ? '未加载' : st && st.routeExists ? '就绪' : '路由缺失'
      // 调用次数不上状态条：它每次启动归零，摆在这里只是噪音；tooltip 里仍可查
      const tail = st
        ? (model || '无默认路由') + (st.lastMs ? ' · 最近 ' + (st.lastMs / 1000).toFixed(1) + 's' : '')
        : ''

      return h('div', {
        title: st
          ? ('Auxesis v' + st.version + '\n' + st.settingsPath
            + '\n已沉淀模式 ' + st.patterns + ' 张 · 套路 ' + (st.playbooks || 0) + ' 条'
            + '\n本次启动：调用 ' + st.calls + ' 次（步骤 ' + (st.stepsCalls || 0) + ' · 调查 ' + (st.investigations || 0) + '）')
          : 'Auxesis 未响应',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, lineHeight: '18px',
          padding: '2px 9px', borderRadius: 999, margin: '2px auto',
          border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
          background: 'var(--dsh-surface-2, rgba(127,127,127,.06))',
          color: 'inherit', opacity: 0.9, userSelect: 'none',
        },
      },
        h('span', { style: { width: 7, height: 7, borderRadius: 4, background: color, flex: '0 0 auto' } }),
        h('span', { style: { fontWeight: 600, letterSpacing: 0.2 } }, 'Auxesis'),
        h('span', { style: { opacity: 0.75 } }, state),
        tail ? h('span', { style: { opacity: 0.6 } }, tail) : null,
      )
    }

    // ── 工具行：模型调用 auxesis 时用专属卡片，而不是通用「工具调用」行
    function argsOf(block) {
      try {
        const settled = block && 'kind' in block
        const raw = String((settled ? block.call && block.call.argsRaw : block && block.argsRaw) || '')
        const parsed = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function resultTextOf(block) {
      if (!block || !Array.isArray(block.content)) return ''
      const parts = []
      for (const item of block.content) {
        parts.push(item && item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
      }
      return parts.join('\n')
    }

    function AuxesisRow(props) {
      const [open, setOpen] = React.useState(false)
      const block = props.block
      const settled = !!(block && 'kind' in block)
      const args = argsOf(block)
      const problem = String(args.problem || args.goal || args.focus || '').replace(/\s+/g, ' ').trim()
      const tool = props.toolName || ''
      const want = args.want || ''
      const label = (tool === 'auxesis_steps' || want === 'steps') ? '◈ Auxesis·步骤'
        : tool === 'auxesis_investigate' ? '◈ Auxesis·调查'
          : '◈ Auxesis'
      const shown = problem.length > 64 ? problem.slice(0, 64) + '…' : problem
      const out = settled ? resultTextOf(block) : ''
      const head = out ? out.split('\n')[0] : ''
      const dur = /([0-9]+\.[0-9])s/.exec(head)
      const failed = settled && (block.isError || (block.error && block.error.code !== 'interrupted'))
      const state = !settled ? '推理中…' : failed ? '失败' : (dur ? dur[1] + 's' : '完成')
      const expandable = settled && out !== ''
      const running = !settled

      return h('div', { style: { margin: '2px 0' } },
        h('div', {
          role: expandable ? 'button' : undefined,
          tabIndex: expandable ? 0 : undefined,
          onClick: expandable ? () => setOpen((v) => !v) : undefined,
          onKeyDown: expandable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } } : undefined,
          style: {
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '20px',
            cursor: expandable ? 'pointer' : 'default', minWidth: 0,
          },
        },
          h('span', { style: { color: ACCENT, fontWeight: 600, flex: '0 0 auto' } }, label),
          running ? h('span', { className: 'aux-dot' }) : null,
          h('span', { style: { opacity: 0.45, flex: '0 0 auto' } }, '·'),
          h('span', {
            style: { opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
          }, shown || '（自包含题面）'),
          h('span', {
            style: {
              marginLeft: 'auto', flex: '0 0 auto', opacity: 0.6,
              color: failed ? '#e5484d' : undefined,
            },
          }, state),
        ),
        running ? h('div', { className: 'aux-run-bar' }) : null,
        open && expandable
          ? h('pre', {
              style: {
                margin: '4px 0 2px', padding: '8px 10px', borderRadius: 8, maxHeight: 280, overflow: 'auto',
                fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: 'var(--dsh-surface-2, rgba(127,127,127,.06))',
                border: '1px solid var(--dsh-border, rgba(127,127,127,.25))',
              },
            }, out)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 调用特效：运行中一道高光从左扫到右 + 标题前脉冲点；尊重 reduced-motion
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-auxesis')
          style.textContent = [
            '@keyframes aux-sweep{0%{background-position:-120% 0}100%{background-position:220% 0}}',
            '@keyframes aux-pulse{0%,100%{opacity:.25}50%{opacity:1}}',
            '.aux-run-bar{height:2px;border-radius:1px;margin-top:2px;background:linear-gradient(90deg,transparent,rgba(122,162,247,.85),transparent);background-size:220% 100%;animation:aux-sweep 1.5s linear infinite}',
            '.aux-dot{width:6px;height:6px;border-radius:3px;background:#7aa2f7;animation:aux-pulse 1.1s ease-in-out infinite;flex:0 0 auto}',
            '.aux-toggle{background:transparent;transition:background .18s ease,border-color .18s ease,opacity .18s ease}',
            '.aux-toggle[data-on="1"]{background:rgba(48,164,108,.14)}',
            '.aux-toggle:hover{background:rgba(127,127,127,.08)}',
            '.aux-toggle[data-on="1"]:hover{background:rgba(48,164,108,.2)}',
            '.aux-toggle:active{transform:scale(.97)}',
            '@media (prefers-reduced-motion: reduce){.aux-run-bar,.aux-dot{animation:none}.aux-toggle{transition:none}}',
          ].join('\n')
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-auxesis: 调用特效样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        const off = slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'auxesis', order: 41, label: 'Auxesis · 能力增益' },
          () => h(Panel),
        ))
        if (typeof off === 'function') ctx.effect(() => off, 'dsh-auxesis: 设置页')

        // 旧会话里的 auxesis_steps 卡片仍用同一行样式渲染，但不再注册这个工具
        for (const key of ['auxesis', 'auxesis_investigate']) {
          ctx.effect(() => slots.inject('tool.call.toolview', () => slots.register(
            { name: 'tool.call.toolview', key },
            AuxesisRow,
          )), 'dsh-auxesis: 工具行 ' + key)
        }

        // 输入框内入口：composer.dock 在框外，所以直接把这个 22px 图标插进输入框容器，
        // 通过事件驱动下面的面板。DOM 会被 React 重渲染，所以用 MutationObserver + 定时器补挂。
        ctx.effect(() => {
          const findBox = () => {
            // DSH 的输入框是 contenteditable，不是 textarea；两种都认，取最靠下的那个
            const tas = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter((t) => {
              const r = t.getBoundingClientRect()
              return r.width > 120 && r.height > 24 && getComputedStyle(t).visibility !== 'hidden'
            })
            if (!tas.length) return null
            tas.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
            let el = tas[0].parentElement
            for (let i = 0; i < 4 && el; i++) {
              const cs = getComputedStyle(el)
              if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) > 0) return el
              el = el.parentElement
            }
            return tas[0].parentElement
          }
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.textContent = '◈'
          btn.setAttribute('data-aux-verify', '1')
          btn.title = '校验：把会话里说过的话和盘上现在的事实，交给 auxesis 外部核一遍'
          Object.assign(btn.style, {
            position: 'absolute', right: '10px', top: '6px', zIndex: 6,
            width: '22px', height: '22px', padding: '0', borderRadius: '6px', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '13px', lineHeight: '20px',
            border: '1px solid var(--dsh-border, rgba(127,127,127,.25))',
            background: 'transparent', color: 'inherit', opacity: '0.5',
          })
          btn.addEventListener('mouseenter', () => { btn.style.opacity = '1' })
          btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.5' })
          btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            window.dispatchEvent(new CustomEvent('dsh-auxesis:verify'))
          })
          let marked = false
          const attach = () => {
            const box = findBox()
            if (!box) return
            if (getComputedStyle(box).position === 'static') box.style.position = 'relative'
            if (btn.parentElement !== box) box.appendChild(btn)
            if (!marked) {
              marked = true
              window.__dshAuxAnchored = true
              window.dispatchEvent(new CustomEvent('dsh-auxesis:anchored'))
            }
          }
          const mo = new MutationObserver(attach)
          mo.observe(document.body, { childList: true, subtree: true })
          const timer = setInterval(attach, 800)
          attach()
          return () => {
            mo.disconnect()
            clearInterval(timer)
            btn.remove()
            window.__dshAuxAnchored = false
          }
        }, 'dsh-auxesis: 输入框内校验入口')

        ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register(
          { name: 'conversation.composer.dock', id: 'auxesis-correct', order: 38 },
          CorrectChip,
        )), 'dsh-auxesis: 复核按钮')

        ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register(
          { name: 'conversation.composer.dock', id: 'auxesis-auto', order: 39 },
          AutoDecideChip,
        )), 'dsh-auxesis: 自动决策开关')

        ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register(
          { name: 'conversation.composer.dock', id: 'auxesis-status', order: 40 },
          StatusChip,
        )), 'dsh-auxesis: 状态条')
      },
    }
  },
})
