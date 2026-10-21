import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { apply } from '../../index.mjs';

// Exercise the published plugin through real fetch/HTTP, without provider credentials.
test('Argon wire replay keeps call identity and removes unsigned commentary gaps', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ body: Buffer.concat(chunks).toString(), headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const originalFetch = globalThis.fetch;
  let dispose;
  apply({
    effect(fn) { dispose = fn(); },
    llm: { registration() { const error = new Error('No provider in HTTP fixture'); error.code = 'NO_ADAPTER'; throw error; } },
    on() { return () => {}; },
    logger: { info() {} },
  });
  const base = `http://127.0.0.1:${server.address().port}/v1beta/models/`;
  const sentinel = 'skip_thought_signature_validator';
  const calls = [
    { functionCall: { name: 'write', id: 'one', args: { text: 'alpha', nested: { keep: true } } }, thoughtSignature: 'AQIDBA==' },
    { functionCall: { name: 'ops_bash', id: 'two', args: { command: 'echo OK' } } },
    { functionCall: { name: 'ops_bash', id: 'three', args: { command: 'echo NEXT' } } },
  ];
  const parts = [{ text: 'before' }, calls[0], calls[1], { text: 'between' }, calls[2], { text: 'after' }];
  const responses = calls.map(({ functionCall: call }) => ({ functionResponse: { name: call.name, id: call.id, response: { output: 'OK' } } }));
  const payload = { contents: [{ role: 'model', parts }, { role: 'user', parts: responses }] };
  const original = structuredClone(payload);
  const send = async (body, model = 'gemini-4-argon') => {
    const headers = { 'content-type': 'application/json', 'x-fixture': 'retained' };
    const response = await fetch(base + model + ':streamGenerateContent', { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    await response.json();
    return received.at(-1);
  };
  try {
    for (const binary of [false, true]) {
      const raw = JSON.stringify(payload);
      const observed = await send(binary ? new TextEncoder().encode(raw) : raw);
      const body = JSON.parse(observed.body);
      const output = body.contents[0].parts;
      assert.deepEqual(output.map((part) => part.text ?? part.functionCall.id), ['before', 'between', 'one', 'two', 'three', 'after']);
      assert.deepEqual(output.filter((part) => part.functionCall).map((part) => part.functionCall), calls.map((part) => part.functionCall));
      assert.equal(output[2].thoughtSignature, calls[0].thoughtSignature);
      assert.equal(output[3].thoughtSignature, sentinel);
      assert.equal(output[4].thoughtSignature, sentinel);
      assert.deepEqual(body.contents[1].parts, responses);
      assert.equal(observed.headers['x-fixture'], 'retained');
      const again = await send(observed.body);
      assert.equal(again.body, observed.body);
    }
    assert.deepEqual(payload, original);

    for (const gap of [
      { text: 'signed', thoughtSignature: 'BQYHCA==' },
      { text: 'thinking', thought: true },
      { inlineData: { mimeType: 'image/png', data: 'AA==' } },
    ]) {
      const body = { contents: [{ role: 'model', parts: [calls[0], gap, calls[1]] }] };
      const observed = JSON.parse((await send(JSON.stringify(body))).body);
      assert.deepEqual(observed.contents[0].parts[1], gap);
      assert.deepEqual(observed.contents[0].parts.map((part) => part.functionCall?.id ?? 'gap'), ['one', 'gap', 'two']);
    }
    const raw = JSON.stringify(payload);
    assert.equal((await send(raw, 'gemini-2.5-pro')).body, raw);
  } finally {
    dispose();
    assert.equal(globalThis.fetch, originalFetch);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
