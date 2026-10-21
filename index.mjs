export const name = 'pi-ai-argon-fix';
export const inject = ['llm'];

export function install(adapter) {
  const original = adapter.streamWithSnapshot;
  if (typeof original !== 'function') throw new Error('Argon fix requires a pi-ai adapter');
  const patched = function (request, snapshot) {
    if (!['google', 'google-vertex'].includes(request.provider) || request.model !== 'gemini-4-argon') {
      return original.call(this, request, snapshot);
    }
    const upstream = snapshot.models;
    const models = Object.create(upstream);
    models.streamSimple = (model, context, options) => upstream.streamSimple(model, context, {
      ...options,
      async onPayload(params, wireModel) {
        const payload = await options.onPayload?.(params, wireModel) ?? params;
        const thinkingConfig = { ...payload.config?.thinkingConfig, includeThoughts: true };
        delete thinkingConfig.thinkingBudget;
        const effort = options.reasoning ?? 'low';
        const mapped = model.thinkingLevelMap?.[effort] ?? effort;
        const level = String(mapped).toUpperCase();
        thinkingConfig.thinkingLevel = ['LOW', 'MEDIUM', 'HIGH'].includes(level) ? level : 'HIGH';
        return { ...payload, config: { ...payload.config, thinkingConfig } };
      },
    });
    // A per-call facade preserves captured snapshots and concurrent providers.
    return original.call(this, request, { ...snapshot, models });
  };
  adapter.streamWithSnapshot = patched;
  return () => {
    if (adapter.streamWithSnapshot === patched) adapter.streamWithSnapshot = original;
  };
}

export function apply(ctx) {
  // Provider routes may register after this plugin starts, so bind on the
  // registry event instead of failing when no adapter exists yet.
  ctx.effect(() => {
    const installed = new Map();
    const sync = () => {
      for (const provider of ['google', 'google-vertex']) {
        let adapter;
        try {
          adapter = ctx.llm.registration(provider).adapter;
        } catch (error) {
          if (error.code !== 'NO_ADAPTER') throw error;
          continue;
        }
        if (installed.has(adapter)) continue;
        installed.set(adapter, install(adapter));
      }
    };
    sync();
    const off = ctx.on('llm/adapters-updated', sync);
    return () => {
      off?.();
      for (const dispose of installed.values()) dispose();
      installed.clear();
    };
  }, 'pi-ai-argon-fix: argon adapter patches');
  ctx.logger.info('Argon requests now use thinkingLevel without thinkingBudget');
}
