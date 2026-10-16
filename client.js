window.__ModuleLoader__.load({
  id: 'dsh-pi-ai-argon-fix',
  factory: (require) => {
    const React = require('react');
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const SLOT = 'conversation.chat.node';
    const CSS = `
      .argon-reasoning{min-width:0;margin:4px 0 12px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;overflow:hidden}
      .argon-reasoning>button{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:13px;text-align:left;cursor:pointer}
      .argon-reasoning>button:focus-visible{outline:2px solid currentColor;outline-offset:-3px}
      .argon-reasoning svg{flex:none;transition:transform .12s}
      .argon-reasoning [aria-expanded=true] svg{transform:rotate(90deg)}
      .argon-reasoning-count{margin-left:auto;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#777)}
      .argon-reasoning-body{padding:4px 14px 12px;max-height:360px;overflow:auto;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#555)}
      .argon-reasoning-preview{margin:0;padding:0 12px 10px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#777);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .argon-waiting{margin:6px 0;color:var(--dsw-alias-label-tertiary,#777);font-size:12px}
      @media(prefers-reduced-motion:reduce){.argon-reasoning svg{transition:none}}
    `;

    function isArgon(route) {
      return ['google', 'google-vertex'].includes(route?.provider) && route?.model === 'gemini-4-argon';
    }

    function previewOf(text) {
      const lines = text.trim().split(/\r?\n/);
      if (/^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(lines[0] ?? '')) lines.shift();
      return lines.join(' ').replace(/\*\*/g, '').trim().slice(0, 200);
    }

    function Reasoning({ text, running, mode, zh }) {
      const [chosenOpen, setChosenOpen] = React.useState(null);
      const open = chosenOpen ?? (mode === 'detailed' || mode === 'verbose');
      const bodyId = React.useId();
      const labels = { code: { copyLabel: zh ? '复制' : 'Copy', copiedLabel: zh ? '已复制' : 'Copied' }, footnotes: zh ? '脚注' : 'Footnotes' };
      const title = zh ? '推理摘要' : 'Reasoning summary';
      const count = `${text.length.toLocaleString()} ${zh ? '字符' : 'characters'}`;
      return h('section', { className: 'argon-reasoning', 'data-argon-reasoning': true },
        h('button', { type: 'button', 'aria-expanded': open, 'aria-controls': bodyId, onClick: () => setChosenOpen(!open) },
          h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true }, h('path', { d: 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 })),
          h('span', null, title, running ? (zh ? ' · 接收中' : ' · receiving') : ''),
          h('span', { className: 'argon-reasoning-count' }, count)),
        open ? h('div', { id: bodyId, className: 'argon-reasoning-body' }, h(MarkdownText, { text, streaming: running, labels, variant: 'compact' }))
          : h('p', { id: bodyId, className: 'argon-reasoning-preview' }, previewOf(text)));
    }

    const EMPTY_ROUTE = { subscribe: () => () => {}, getSnapshot: () => undefined };
    const routeDefinition = {
      kind: 'argon-request-route',
      match: (event) => ['assistant/message', 'assistant/live-chunk'].includes(event.type)
        ? { id: `${event.data.turn}:${event.data.step}`, role: 'start' } : null,
      start: (_context, match, reader) => {
        const route = match.event.data.message?.source ?? reader.previous('request-prompt')?.state?.prompt?.config;
        return { provider: route?.provider, model: route?.model };
      },
      update: (context, match) => {
        const route = match.event.data.message?.source;
        return route ? { provider: route.provider, model: route.model } : context.state;
      },
      buildLocationData: (context, scope) => {
        const location = context.start?.location;
        if (scope !== 'step' || location?.kind !== 'step' || !context.state) return null;
        return { kind: 'step', turn: location.turn.turn, step: location.step.step, key: 'argon-request-route', value: context.state };
      },
    };

    function decorate(Original) {
      return function ArgonAssistant(props) {
        const mode = props.usePresentation((policy) => policy.mode);
        const source = props.node.location?.kind === 'step' ? props.node.location.step.data.source('argon-request-route') : EMPTY_ROUTE;
        const historical = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
        const data = props.node.data;
        // Use the route recorded for this step, never the current model picker.
        const route = data.finalNode?.providerMetadata ?? data.finalNode?.requestConfig ?? historical;
        if (!isArgon(route) || props.groupPart === 'response') return h(Original, props);
        const zh = props.t('message.think') === '思考';
        const children = [];
        let start = 0;
        const originalRange = (end) => {
          if (end <= start) return;
          const node = { ...props.node, data: { ...data, blocks: data.blocks.slice(start, end), status: end === data.blocks.length ? data.status : 'settled' } };
          children.push(h(Original, { ...props, node, key: `original-${start}` }));
        };
        for (let index = 0; index < data.blocks.length; index++) {
          const block = data.blocks[index];
          if (block.kind !== 'reasoning') continue;
          originalRange(index);
          if (block.text.trim()) children.push(h(Reasoning, { key: `reasoning-${index}`, text: block.text, running: data.status === 'running' && index === data.blocks.length - 1, mode, zh }));
          start = index + 1;
        }
        originalRange(data.blocks.length);
        if (data.status === 'running' && data.blocks.at(-1)?.kind === 'reasoning') {
          children.push(h('p', { key: 'waiting', className: 'argon-waiting', role: 'status' }, zh ? '模型仍在生成，等待后续正文或工具参数。' : 'The model is still generating; waiting for further text or tool arguments.'));
        }
        return h('div', { 'data-argon-assistant': true }, children);
      };
    }

    function apply(ctx) {
      ctx.effect(() => ctx.uiConversation.events.register(routeDefinition));
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.argonFix = 'presentation';
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      });
      // Shadow the public keyed seat, while preserving the original renderer's hooks.
      // No session event, provider payload, tool renderer, or DOM subtree is rewritten.
      ctx.slots.inject(SLOT, () => {
        let dispose;
        const mount = () => {
          if (dispose) return;
          const base = ctx.slots.entriesOfSlot(SLOT).find((entry) => entry.options.key === 'assistant-step');
          if (!base?.component || !base.inject) return;
          dispose = ctx.slots.register({ name: SLOT, key: 'assistant-step', priority: (base.options.priority ?? 0) - 1, locale: base.locale, inject: base.inject }, decorate(base.component));
        };
        const unsubscribe = ctx.slots.subscribe(SLOT, mount);
        mount();
        return () => { unsubscribe(); dispose?.(); };
      });
    }

    return { apply, inject: ['slots', 'uiConversation'], isArgon, previewOf, decorate };
  },
});
