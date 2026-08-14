#!/usr/bin/env node
/** Repo-only exact-viewport capture for the adaptive A/B evaluation. */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) throw new Error(`invalid option: ${option ?? ''}`);
    result[option.slice(2)] = value;
  }
  const width = Number(result.width);
  const height = Number(result.height);
  if (!result.chrome || !result.url || !result.output) throw new Error('--chrome, --url, and --output are required');
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error('--width and --height must be positive integers');
  }
  return { ...result, width, height };
}

function browserWebSocket(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Chrome DevTools endpoint timed out.\n${output}`)), 15000);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stderr.on('data', inspect);
    child.stdout.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before exposing DevTools (exit ${code}).\n${output}`));
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools WebSocket connection failed')), { once: true });
  });
}

function protocol(socket) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    send(method, params = {}, sessionId = undefined) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    once(method, sessionId) {
      return new Promise((resolve) => {
        const listener = (message) => {
          if (message.method !== method || message.sessionId !== sessionId) return;
          listeners.delete(listener);
          resolve(message.params ?? {});
        };
        listeners.add(listener);
      });
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileDir = mkdtempSync(path.join(tmpdir(), 'p2a-chrome-profile-'));
  const child = spawn(args.chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let socket;
  try {
    const webSocketUrl = await browserWebSocket(child);
    socket = await connect(webSocketUrl);
    const cdp = protocol(socket);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: args.width,
      height: args.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: args.width,
      screenHeight: args.height,
    }, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: args.url }, sessionId);
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const metrics = await cdp.send('Runtime.evaluate', {
      expression: '({width: window.innerWidth, height: window.innerHeight})',
      returnByValue: true,
    }, sessionId);
    const viewport = metrics.result?.value;
    if (viewport?.width !== args.width || viewport?.height !== args.height) {
      throw new Error(`viewport mismatch: expected ${args.width}x${args.height}, got ${viewport?.width}x${viewport?.height}`);
    }
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    }, sessionId);
    mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    writeFileSync(path.resolve(args.output), Buffer.from(screenshot.data, 'base64'));
  } finally {
    socket?.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(resolve, 2000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const resolvedTemp = path.resolve(tmpdir());
    const resolvedProfile = path.resolve(profileDir);
    if (resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`)) {
      try {
        rmSync(resolvedProfile, { recursive: true, force: true });
      } catch {
        // Chrome can briefly retain singleton files after exit; capture success
        // must not be converted into an evaluation failure by temp cleanup.
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
