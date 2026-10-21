export const name = 'pi-ai-argon-fix';
export const inject = ['llm'];

const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

function normalizeReplayPayload(payload) {
  if (!Array.isArray(payload?.contents)) return payload;
  let changed = false;
  const contents = payload.contents.map((content) => {
    if (!Array.isArray(content?.parts)) return content;
    let contentChanged = false;
    let replayParts = content.parts;
    if (content.role === 'model') {
      const first = replayParts.findIndex((part) => part?.functionCall);
      const last = replayParts.findLastIndex((part) => part?.functionCall);
      const middle = replayParts.slice(first, last + 1);
      const isCommentary = (part) => typeof part?.text === 'string' &&
        part.thought !== true && !part.thoughtSignature &&
        Object.keys(part).every((key) => key === 'text' || key === 'thought');
      if (first >= 0 && middle.some(isCommentary) &&
          middle.every((part) => part?.functionCall || isCommentary(part))) {
        // CPA clears sibling sentinels; intervening text then starts an unsigned call group.
        // Move only unsigned commentary, retaining every call and its original signature.
        replayParts = [
          ...replayParts.slice(0, first),
          ...middle.filter(isCommentary),
          ...middle.filter((part) => part.functionCall),
          ...replayParts.slice(last + 1),
        ];
        changed = true;
        contentChanged = true;
      }
    }
    const parts = replayParts.map((part) => {
      if (!part?.functionCall || part.thoughtSignature) return part;
      changed = true;
      contentChanged = true;
      return { ...part, thoughtSignature: SKIP_THOUGHT_SIGNATURE };
    });
    return contentChanged ? { ...content, parts } : content;
  });
  return changed ? { ...payload, contents } : payload;
}

function patchWireBody(body) {
  let text;
  let binary = false;
  if (typeof body === 'string') {
    text = body;
  } else if (body instanceof Uint8Array) {
    text = new TextDecoder().decode(body);
    binary = true;
  } else {
    return body;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return body;
  }
  const patched = normalizeReplayPayload(payload);
  if (patched === payload) return body;
  const next = JSON.stringify(patched);
  return binary ? new TextEncoder().encode(next) : next;
}

function installWirePatch() {
  const originalFetch = globalThis.fetch;
  const patchedFetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!/generateContent/i.test(url) || !/gemini-4-argon/i.test(url) || !init || init.body === undefined) {
      return originalFetch.call(this, input, init);
    }
    const body = patchWireBody(init.body);
    if (body === init.body) return originalFetch.call(this, input, init);
    const headers = new Headers(init.headers);
    headers.delete('content-length');
    return originalFetch.call(this, input, { ...init, body, headers });
  };
  globalThis.fetch = patchedFetch;
  return () => {
    if (globalThis.fetch === patchedFetch) globalThis.fetch = originalFetch;
  };
}

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
        const payload = normalizeReplayPayload(await options.onPayload?.(params, wireModel) ?? params);
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
    const restoreWirePatch = installWirePatch();
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
      restoreWirePatch();
      for (const dispose of installed.values()) dispose();
      installed.clear();
    };
  }, 'pi-ai-argon-fix: argon adapter patches');
  ctx.logger.info('Argon requests now use thinkingLevel without thinkingBudget');
}
