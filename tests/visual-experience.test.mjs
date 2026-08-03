import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  validateVisualExperience,
  validateVisualPrototype,
  validateVisualReviewData,
  validateRunsDir,
  validateSpec,
  validateTaskGraphData,
  ValidationError,
} from '../scripts/validate_artifacts.mjs';
import { readRequiredVisualReview } from '../scripts/p2a_visual_review_gate.mjs';
import {
  taskGraphFromSpecChanges,
  validateCloseReadyVisualEvidence,
} from '../scripts/p2a_iteration.mjs';
import {
  canonicalRunRef,
  canonicalWorkspacePathForArtifactRoot,
  runFilePath,
  runSidecarPath,
  taskContractSha256,
  workspaceRevisionExcludedPaths,
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
} from '../scripts/p2a_run_paths.mjs';
import { runExecute, runHandoff, runIteration, runP2a, runRuns, runTasks, runValidator } from './helpers/fixtures.mjs';

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const OFFLINE_PROTOTYPE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

function prototypeHtml(body) {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${OFFLINE_PROTOTYPE_CSP}">${body}\n`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function writePng(filePath, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height);
  writeFileSync(filePath, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function writeHeaderOnlyPng(filePath, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  writeFileSync(filePath, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function approval(artifacts) {
  return {
    approved_by: 'human-owner',
    approved_at: '2026-08-01T00:00:00.000Z',
    approved_artifacts: artifacts,
    approval_note: 'Approved after reviewing the interactive HTML prototype.',
  };
}

function buildApprovedVisualBundle(root, projectId = 'reviewpane') {
  const gateB = path.join(root, 'gate-b-spec');
  const candidateDir = path.join(gateB, 'visual-design', 'VD-1');
  const alternateCandidateDir = path.join(gateB, 'visual-design', 'VD-2');
  const experiencePath = path.join(gateB, 'experience-spec.json');
  const prototypePath = path.join(candidateDir, 'prototype.json');
  const htmlPath = path.join(candidateDir, 'index.html');
  const alternatePrototypePath = path.join(alternateCandidateDir, 'prototype.json');
  const alternateHtmlPath = path.join(alternateCandidateDir, 'index.html');
  const specPath = path.join(gateB, 'spec.json');
  mkdirSync(candidateDir, { recursive: true });
  mkdirSync(alternateCandidateDir, { recursive: true });
  writeFileSync(htmlPath, prototypeHtml('<title>Review pane</title><main>Ready</main>'), 'utf8');
  writeFileSync(alternateHtmlPath, prototypeHtml('<title>Review queue</title><main>Ready in split view</main>'), 'utf8');
  writeJson(prototypePath, {
    schema_version: 'p2a.visual_prototype.v1',
    project_id: projectId,
    experience_spec_ref: '../../experience-spec.json',
    candidate_id: 'VD-1',
    status: 'approved',
    entrypoint: 'index.html',
    screen_states: [{
      screen_id: 'SCREEN-1',
      states: ['ready'],
      state_artifacts: [{ state: 'ready', artifact_ref: 'index.html' }],
    }],
    viewports: ['desktop'],
    network_policy: 'offline',
    files: [{ path: 'index.html', sha256: sha256(htmlPath), media_type: 'text/html' }],
    approval_audit: approval(['index.html']),
  });
  writeJson(alternatePrototypePath, {
    schema_version: 'p2a.visual_prototype.v1',
    project_id: projectId,
    experience_spec_ref: '../../experience-spec.json',
    candidate_id: 'VD-2',
    status: 'candidate',
    entrypoint: 'index.html',
    screen_states: [{
      screen_id: 'SCREEN-1',
      states: ['ready'],
      state_artifacts: [{ state: 'ready', artifact_ref: 'index.html' }],
    }],
    viewports: ['desktop'],
    network_policy: 'offline',
    files: [{ path: 'index.html', sha256: sha256(alternateHtmlPath), media_type: 'text/html' }],
  });
  writeJson(experiencePath, {
    schema_version: 'p2a.visual_experience.v1',
    project_id: projectId,
    source_spec_ref: 'spec.json',
    mode: 'full',
    visual_direction: {
      keywords: ['focused'],
      references: [],
      avoid: ['dashboard clutter'],
      candidates: [
        {
          id: 'VD-1',
          title: 'Focused review',
          summary: 'One primary review surface with contextual details.',
          tradeoffs: ['Fewer simultaneous panels'],
          prototype_manifest_ref: 'visual-design/VD-1/prototype.json',
          prototype_manifest_sha256: sha256(prototypePath),
        },
        {
          id: 'VD-2',
          title: 'Split review',
          summary: 'A denser comparison surface with a persistent queue.',
          tradeoffs: ['More simultaneous information'],
          prototype_manifest_ref: 'visual-design/VD-2/prototype.json',
          prototype_manifest_sha256: sha256(alternatePrototypePath),
        },
      ],
      selected_candidate: 'VD-1',
    },
    design_system: {
      strategy: 'new',
      references: [],
      token_rules: ['Use semantic color tokens'],
      component_rules: ['Keep the primary action visually dominant'],
    },
    screens: [{
      id: 'SCREEN-1',
      name: 'Review workspace',
      route: '/reviews/:id',
      user_goal: 'Review one change without losing context.',
      entry_points: ['Review queue'],
      primary_action: 'Submit review',
      secondary_actions: ['Open details'],
      regions: [{ id: 'content', purpose: 'Show the item under review', priority: 'primary' }],
      states: ['ready'],
      success_exit: 'The submitted review is visible in the activity log.',
      responsive_rules: ['Collapse details below content under 720px'],
      accessibility_requirements: ['Keyboard access for every review action'],
    }],
    validation: {
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      required_states: ['ready'],
      accessibility_standard: 'WCAG 2.2 AA',
      visual_review_required: true,
    },
    approval: 'approved',
    approval_audit: approval(['visual-design/VD-1/prototype.json']),
  });
  if (!existsSync(specPath)) {
    writeJson(specPath, {
      project_id: projectId,
      approval: 'approved',
      visual_experience: {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This fixture binds its run to approved visual artifacts.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(experiencePath),
      },
      approval_audit: approval(['experience-spec.json']),
    });
  }
  return {
    specPath,
    experiencePath,
    prototypePath,
    htmlPath,
    alternatePrototypePath,
    alternateHtmlPath,
  };
}

function validReview(runId = 'run-task-001-001', evidence = {}, iterationId = 'iter-001', timestamps = {}) {
  const evidenceRoot = `visual-evidence/${iterationId}/${runId}`;
  return {
    schema_version: 'p2a.visual_review.v2',
    run_id: runId,
    iteration_id: iterationId,
    workspace_ref: timestamps.workspaceRef ?? 'visual-task-done-fixture',
    workspace_revision_sha256: timestamps.workspaceRevisionSha256 ?? '0'.repeat(64),
    source_experience_ref: 'experience-spec.json',
    source_prototype_ref: 'visual-design/VD-1/prototype.json',
    reviewed_at: timestamps.reviewedAt ?? '2026-08-01T01:00:00.000Z',
    results: [{
      screen_id: 'SCREEN-1',
      state: 'ready',
      viewport: 'desktop',
      artifact_ref: `${evidenceRoot}/screen-1-ready-desktop.png`,
      artifact_sha256: evidence.artifactSha256 ?? '0'.repeat(64),
      media_type: 'image/png',
      width: 1440,
      height: 900,
      capture_url: 'http://127.0.0.1:4173/reviews/1',
      captured_at: timestamps.capturedAt ?? '2026-08-01T00:58:00.000Z',
      status: 'passed',
      concerns: [],
    }],
    accessibility: {
      status: 'passed',
      report_ref: `${evidenceRoot}/accessibility.json`,
      report_sha256: evidence.reportSha256 ?? '0'.repeat(64),
      standard: 'WCAG 2.2 AA',
      critical_violations: 0,
    },
    verdict: 'confirm_ui',
    concerns: [],
    note: 'Implementation matches the approved prototype.',
  };
}

describe('visual experience artifacts', () => {
  test('validates an approved offline HTML prototype bundle and detects drift', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-experience-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      assert.equal(validateVisualExperience(bundle.experiencePath).approval, 'approved');
      writeFileSync(bundle.htmlPath, '<!doctype html><title>Changed</title>\n', 'utf8');
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /hash does not match manifest/,
      );
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /Content-Security-Policy/,
      );
      writeFileSync(
        bundle.htmlPath,
        `<!doctype html><meta title="http-equiv=content-security-policy" content="${OFFLINE_PROTOTYPE_CSP}"><main>Fake policy</main>`,
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /must declare a Content-Security-Policy meta tag/,
      );
      writeFileSync(
        bundle.htmlPath,
        `<script>globalThis["op" + "en"]("https://example.com")</script>${prototypeHtml('<main>late policy</main>')}`,
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /Content-Security-Policy must precede all prototype content/,
      );
      writeFileSync(bundle.htmlPath, prototypeHtml('<script>fetch("https://example.com")</script>'), 'utf8');
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /violates network_policy offline/,
      );
      writeFileSync(bundle.htmlPath, prototypeHtml('<object data=https://example.com/panel.html></object>'), 'utf8');
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /violates network_policy offline/,
      );
      writeFileSync(bundle.htmlPath, prototypeHtml('<object data="panel.html"></object>'), 'utf8');
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /references undeclared manifest file: panel\.html/,
      );
      writeFileSync(bundle.htmlPath, prototypeHtml('<script src=https://example.com/app.js></script>'), 'utf8');
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /violates network_policy offline/,
      );
      for (const offlineBypass of [
        '<meta http-equiv="refresh" content="0;url=https://example.com">',
        '<meta http-equiv="re&#x66;resh" content="0;url=https://example.com">',
        '<script>location.assign("https://example.com")</script>',
        '<script>new Worker("https://example.com/worker.js")</script>',
        '<script>open("https://example.com")</script>',
        '<script>top.open("https://example.com")</script>',
        '<script>window["open"]("https://example.com")</script>',
      ]) {
        writeFileSync(bundle.htmlPath, prototypeHtml(offlineBypass), 'utf8');
        manifest.files[0].sha256 = sha256(bundle.htmlPath);
        writeJson(bundle.prototypePath, manifest);
        assert.throws(
          () => validateVisualPrototype(bundle.prototypePath),
          /violates network_policy offline/,
        );
      }
      for (const computedNavigationBypass of [
        '<button onclick="location[[\'as\',\'sign\'].join(\'\')]([\'https:\',\'//example.com\'].join(\'\'))">Leave</button>',
        '<a href="https&colon;&sol;&sol;example.com">Leave</a>',
        '<a href="data:text/html,external">Leave</a>',
      ]) {
        writeFileSync(bundle.htmlPath, prototypeHtml(computedNavigationBypass), 'utf8');
        manifest.files[0].sha256 = sha256(bundle.htmlPath);
        writeJson(bundle.prototypePath, manifest);
        assert.throws(
          () => validateVisualPrototype(bundle.prototypePath),
          /network_policy offline|must not contain executable script/,
        );
      }
      const overridingCsp = `${OFFLINE_PROTOTYPE_CSP}; script-src-elem https:`;
      writeFileSync(
        bundle.htmlPath,
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${overridingCsp}">`
          + '<script>const node=document.createElement("script");'
          + 'node.setAttribute(["s","rc"].join(""),["https:","//example.com/app.js"].join(""));'
          + 'document.head.append(node)</script>\n',
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /must not include additional directives: script-src-elem/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects PNG files whose decompressed scanlines do not match their declared dimensions', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-png-structure-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const imagePath = path.join(path.dirname(bundle.htmlPath), 'empty.png');
      writeHeaderOnlyPng(imagePath, 1440, 900);
      writeFileSync(bundle.htmlPath, prototypeHtml('<img src="empty.png">'), 'utf8');
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      manifest.files.push({ path: 'empty.png', sha256: sha256(imagePath), media_type: 'image/png' });
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /pixel data is shorter than its declared dimensions/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects indexed PNG files without a palette', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-png-palette-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const imagePath = path.join(path.dirname(bundle.htmlPath), 'indexed.png');
      const header = Buffer.alloc(13);
      header.writeUInt32BE(1, 0);
      header.writeUInt32BE(1, 4);
      header[8] = 8;
      header[9] = 3;
      writeFileSync(imagePath, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(Buffer.from([0, 0]))),
        pngChunk('IEND', Buffer.alloc(0)),
      ]));
      writeFileSync(bundle.htmlPath, prototypeHtml('<img src="indexed.png">'), 'utf8');
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      manifest.files.push({ path: 'indexed.png', sha256: sha256(imagePath), media_type: 'image/png' });
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /indexed-color PNG must contain a PLTE chunk/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bounds PNG decompression before materializing oversized scanline data', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-png-limit-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const imagePath = path.join(path.dirname(bundle.htmlPath), 'oversized.png');
      const header = Buffer.alloc(13);
      header.writeUInt32BE(1, 0);
      header.writeUInt32BE(1, 4);
      header[8] = 8;
      header[9] = 0;
      writeFileSync(imagePath, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))),
        pngChunk('IEND', Buffer.alloc(0)),
      ]));
      writeFileSync(bundle.htmlPath, prototypeHtml('<img src="oversized.png">'), 'utf8');
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      manifest.files.push({ path: 'oversized.png', sha256: sha256(imagePath), media_type: 'image/png' });
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /invalid compressed PNG image data/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects oversized prototype files before hashing or parsing their content', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-file-limit-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const stylePath = path.join(path.dirname(bundle.htmlPath), 'oversized.css');
      writeFileSync(stylePath, '', 'utf8');
      truncateSync(stylePath, (25 * 1024 * 1024) + 1);
      writeFileSync(bundle.htmlPath, prototypeHtml('<link rel="stylesheet" href="oversized.css">'), 'utf8');
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      manifest.files.push({
        path: 'oversized.css',
        sha256: '0'.repeat(64),
        media_type: 'text/css',
      });
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /file size exceeds the 26214400 byte limit/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects undeclared prototype dependencies and media-type disguises', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-prototype-closure-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const stylePath = path.join(path.dirname(bundle.htmlPath), 'app.css');
      writeFileSync(stylePath, 'main { display: block; }\n', 'utf8');
      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<link rel="stylesheet" href="app.css">'),
        'utf8',
      );
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /missing from the manifest: app\.css/,
      );
      manifest.files.push({ path: 'app.css', sha256: sha256(stylePath), media_type: 'application/json' });
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /media_type .* does not match its extension/,
      );
      writeFileSync(stylePath, '@import "./missing.css";\nmain { display: block; }\n', 'utf8');
      manifest.files[1].media_type = 'text/css';
      manifest.files[1].sha256 = sha256(stylePath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /references undeclared manifest file: missing\.css/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps per-screen states and canonical portable references internally consistent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-state-contract-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const experience = JSON.parse(readFileSync(bundle.experiencePath, 'utf8'));
      experience.screens[0].states.push('error');
      writeJson(bundle.experiencePath, experience);
      assert.throws(
        () => validateVisualExperience(bundle.experiencePath),
        /validation\.required_states/,
      );
      experience.validation.required_states.push('error');
      experience.source_spec_ref = 'iterations/iteration-0001/gate-b-spec/spec.json';
      writeJson(bundle.experiencePath, experience);
      assert.throws(
        () => validateVisualExperience(bundle.experiencePath),
        /source_spec_ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires every declared prototype state to map to reachable HTML', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-state-reachability-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const errorPath = path.join(path.dirname(bundle.htmlPath), 'state-error.html');
      writeFileSync(errorPath, prototypeHtml('<main id="error">Error</main>'), 'utf8');
      const manifest = JSON.parse(readFileSync(bundle.prototypePath, 'utf8'));
      manifest.screen_states[0].states.push('error');
      manifest.screen_states[0].state_artifacts.push({
        state: 'error',
        artifact_ref: 'state-error.html#error',
      });
      manifest.files.push({
        path: 'state-error.html',
        sha256: sha256(errorPath),
        media_type: 'text/html',
      });
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /artifact_ref is not reachable from index\.html/,
      );

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<main>Ready</main><!-- <a href="state-error.html#error">Commented error</a> -->'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /artifact_ref is not reachable from index\.html/,
      );

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<main>Ready</main><template><a href="state-error.html#error">Template error</a></template>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /artifact_ref is not reachable from index\.html/,
      );

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<main>Ready</main><a hidden href="state-error.html#error">Hidden error</a>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /artifact_ref is not reachable from index\.html/,
      );

      for (const hiddenNavigation of [
        '<main>Ready</main><noscript><a href="state-error.html#error">No-script error</a></noscript>',
        '<main>Ready</main><div inert><a href="state-error.html#error">Inert error</a></div>',
        '<main>Ready</main><dialog><a href="state-error.html#error">Closed dialog error</a></dialog>',
      ]) {
        writeFileSync(bundle.htmlPath, prototypeHtml(hiddenNavigation), 'utf8');
        manifest.files[0].sha256 = sha256(bundle.htmlPath);
        writeJson(bundle.prototypePath, manifest);
        assert.throws(
          () => validateVisualPrototype(bundle.prototypePath),
          /artifact_ref is not reachable from index\.html/,
        );
      }

      for (const cssNavigation of [
        '<main>Ready</main><a style="display:/**/none" href="state-error.html#error">Comment-hidden error</a>',
        '<style>.shell .state-hidden { display: none }</style><main class="shell"><a class="state-hidden" href="state-error.html#error">CSS-hidden error</a></main>',
        String.raw`<style>.state-hidden { d\69 splay: none }</style><main><a class="state-hidden" href="state-error.html#error">Escaped-property error</a></main>`,
        '<style>.state-hidden { d\\69\r\nsplay: none }</style><main><a class="state-hidden" href="state-error.html#error">CRLF-escaped-property error</a></main>',
        '<style>#state-link { display: none }.state-link.state-link.state-link.state-link.state-link.state-link.state-link.state-link.state-link.state-link.state-link { display: block }</style><main><a id="state-link" class="state-link" href="state-error.html#error">Specificity-hidden error</a></main>',
        '<style>#state-link { display: none }#state-link { content: "; display: block;" }</style><main><a id="state-link" href="state-error.html#error">Quoted-declaration error</a></main>',
      ]) {
        writeFileSync(bundle.htmlPath, prototypeHtml(cssNavigation), 'utf8');
        manifest.files[0].sha256 = sha256(bundle.htmlPath);
        writeJson(bundle.prototypePath, manifest);
        assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));
      }

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<style>a:not(.visible) { display: none }</style><main>Ready</main><a href="state-error.html#error">Unsupported hidden error</a>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<style>@layer visible { #state-link { display: block } }.state-link { display: none }</style><main><a id="state-link" class="state-link" href="state-error.html#error">Layer-hidden error</a></main>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml(String.raw`<style>@\6c ayer hidden { #state-link { display: none } }</style><main><a id="state-link" href="state-error.html#error">Escaped-layer error</a></main>`),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml(String.raw`<style>@l\61 yer hidden { #state-link { display: none } }</style><main><a id="state-link" href="state-error.html#error">Partially-escaped-layer error</a></main>`),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<style>.state-link { display: none }@supports not (display: block) { #state-link { display: block } }</style><main><a id="state-link" class="state-link" href="state-error.html#error">Conditional error</a></main>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      const stylesheetPath = path.join(path.dirname(bundle.htmlPath), 'state.css');
      writeFileSync(stylesheetPath, '.state-hidden { visibility: hidden }\n', 'utf8');
      manifest.files.push({
        path: 'state.css',
        sha256: sha256(stylesheetPath),
        media_type: 'text/css',
      });
      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<link rel="stylesheet" href="state.css"><main>Ready</main><a class="state-hidden" href="state-error.html#error">CSS-file error</a>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      for (const visibleNavigation of [
        '<style media="print">.state-link { display: none }</style><main>Ready</main><a class="state-link" href="state-error.html#error">Screen-visible error</a>',
        '<style>@media print { .state-link { display: none } }</style><main>Ready</main><a class="state-link" href="state-error.html#error">Media-visible error</a>',
        '<style>.state-link { display: none }a.state-link { display: block }</style><main>Ready</main><a class="state-link" href="state-error.html#error">Cascade-visible error</a>',
        '<style>.shell { visibility: hidden }.shell .state-link { visibility: visible }</style><main class="shell"><a class="state-link" href="state-error.html#error">Visibility-visible error</a></main>',
        '<link rel="stylesheet" href="state.css" disabled><main>Ready</main><a class="state-hidden" href="state-error.html#error">Disabled-style error</a>',
      ]) {
        writeFileSync(bundle.htmlPath, prototypeHtml(visibleNavigation), 'utf8');
        manifest.files[0].sha256 = sha256(bundle.htmlPath);
        writeJson(bundle.prototypePath, manifest);
        assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));
      }

      writeFileSync(
        bundle.htmlPath,
        prototypeHtml('<main>Ready</main><a href="state-error.html#error">Show error</a>'),
        'utf8',
      );
      manifest.files[0].sha256 = sha256(bundle.htmlPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));

      writeFileSync(errorPath, prototypeHtml('<template><main id="error">Error</main></template>'), 'utf8');
      manifest.files.find((entry) => entry.path === 'state-error.html').sha256 = sha256(errorPath);
      writeJson(bundle.prototypePath, manifest);
      assert.throws(
        () => validateVisualPrototype(bundle.prototypePath),
        /artifact_ref fragment does not exist/,
      );

      writeFileSync(
        errorPath,
        prototypeHtml('<style>#error { content-visibility: hidden }</style><main id="error">Error</main>'),
        'utf8',
      );
      manifest.files.find((entry) => entry.path === 'state-error.html').sha256 = sha256(errorPath);
      writeJson(bundle.prototypePath, manifest);
      assert.doesNotThrow(() => validateVisualPrototype(bundle.prototypePath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires two full-design candidates and forbids visual review in reuse mode', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-mode-contract-'));
    try {
      const bundle = buildApprovedVisualBundle(root);
      const experience = JSON.parse(readFileSync(bundle.experiencePath, 'utf8'));
      const singleCandidate = structuredClone(experience);
      singleCandidate.visual_direction.candidates = singleCandidate.visual_direction.candidates.slice(0, 1);
      writeJson(bundle.experiencePath, singleCandidate);
      assert.throws(() => validateVisualExperience(bundle.experiencePath), /must contain at least 2 item/);

      const reuse = structuredClone(experience);
      reuse.mode = 'reuse';
      reuse.validation.visual_review_required = false;
      writeJson(bundle.experiencePath, reuse);
      assert.throws(() => validateVisualExperience(bundle.experiencePath), /must be one of/);
      reuse.design_system.strategy = 'existing';
      reuse.design_system.references = ['design-system://reviewpane'];
      writeJson(bundle.experiencePath, reuse);
      assert.equal(validateVisualExperience(bundle.experiencePath).mode, 'reuse');
      reuse.validation.visual_review_required = true;
      writeJson(bundle.experiencePath, reuse);
      assert.throws(() => validateVisualExperience(bundle.experiencePath), /must equal false/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reuse experience must preserve every design-system reference approved by the spec', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-reuse-references-'));
    try {
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const bundle = buildApprovedVisualBundle(root, 'webhook-api-service');
      const experience = JSON.parse(readFileSync(bundle.experiencePath, 'utf8'));
      experience.mode = 'reuse';
      experience.design_system.strategy = 'existing';
      experience.design_system.references = ['design-system://different'];
      experience.validation.visual_review_required = false;
      writeJson(bundle.experiencePath, experience);

      const spec = JSON.parse(readFileSync(bundle.specPath, 'utf8'));
      spec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'reuse',
        design_timing: 'current_iteration',
        rationale: 'This iteration must use the approved shared design system.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(bundle.experiencePath),
        design_system_refs: ['design-system://reviewpane'],
      };
      spec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(bundle.specPath, spec);
      const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
      assert.throws(
        () => validateSpec(bundle.specPath, intakePath, { artifactRoot: root }),
        /design_system_refs contains values outside the approved visual contract/,
      );

      experience.design_system.references.push('design-system://reviewpane');
      writeJson(bundle.experiencePath, experience);
      spec.visual_experience.experience_spec_sha256 = sha256(bundle.experiencePath);
      writeJson(bundle.specPath, spec);
      assert.equal(
        validateSpec(bundle.specPath, intakePath, { artifactRoot: root }).visual_experience.design_scope,
        'reuse',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects experience artifact references for visual modes that do not consume them', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-reference-scope-'));
    try {
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const specPath = path.join(root, 'gate-b-spec', 'spec.json');
      const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      spec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'minimal',
        design_timing: 'current_iteration',
        rationale: 'This iteration follows existing functional layout conventions.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: '0'.repeat(64),
      };
      writeJson(specPath, spec);
      assert.throws(
        () => validateSpec(specPath, intakePath, { artifactRoot: root }),
        /experience_spec_ref is only allowed for full or reuse current_iteration/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('confirm_ui requires complete coverage and passed accessibility', () => {
    const contract = {
      run_id: 'run-task-001-001',
      iteration_id: 'iter-001',
      source_experience_ref: 'experience-spec.json',
      source_prototype_ref: 'visual-design/VD-1/prototype.json',
      screen_states: [{
        screen_id: 'SCREEN-1',
        states: ['ready'],
        state_artifacts: [{ state: 'ready', artifact_ref: 'index.html' }],
      }],
      viewports: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ],
      accessibility_standard: 'WCAG 2.2 AA',
    };
    assert.throws(
      () => validateVisualReviewData(validReview(), contract),
      /missing 1 required/,
    );
    const failedAccessibility = validReview();
    failedAccessibility.accessibility.status = 'not_run';
    failedAccessibility.accessibility.report_ref = null;
    failedAccessibility.accessibility.report_sha256 = null;
    assert.throws(
      () => validateVisualReviewData(failedAccessibility),
      /requires passed accessibility/,
    );
    const staleContract = {
      ...contract,
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      started_at: '2026-08-02T00:00:00.000Z',
    };
    assert.throws(
      () => validateVisualReviewData(validReview(), staleContract),
      /must not predate the run start/,
    );
    const completedContract = {
      ...staleContract,
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T02:00:00.000Z',
    };
    assert.throws(
      () => validateVisualReviewData(validReview(
        'run-task-001-001',
        {},
        'iter-001',
        {
          reviewedAt: '2099-01-01T00:01:00.000Z',
          capturedAt: '2099-01-01T00:00:00.000Z',
        },
      ), completedContract),
      /reviewed_at must not be later than the run finish/,
    );
    const fileCapture = validReview();
    fileCapture.results[0].capture_url = 'file:///tmp/prototype/index.html';
    assert.throws(
      () => validateVisualReviewData(fileCapture),
      /must be an absolute http or https URL/,
    );
    const taskOwnedV2 = validReview();
    taskOwnedV2.task_id = 'task-001';
    assert.throws(() => validateVisualReviewData(taskOwnedV2));
    const iterationOwnedV1 = validReview();
    iterationOwnedV1.schema_version = 'p2a.visual_review.v1';
    iterationOwnedV1.task_id = 'task-001';
    assert.throws(() => validateVisualReviewData(iterationOwnedV1));
  });

  test('an approved full visual spec records task impact without exclusive visual ownership', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-task-'));
    try {
      const fixture = path.resolve('fixtures/_e2e/webhook-api-service');
      cpSync(fixture, root, { recursive: true });
      const visualBundle = buildApprovedVisualBundle(root, 'webhook-api-service');
      const specPath = path.join(root, 'gate-b-spec', 'spec.json');
      const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      spec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This iteration implements the operator review screen.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      spec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(specPath, spec);
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      graph.tasks[0].targetArea = 'frontend-ui';
      assert.throws(
        () => validateTaskGraphData(graph, specPath),
        /workKind is required/,
      );
      for (const task of graph.tasks) task.workKind = 'non_ui';
      assert.throws(
        () => validateTaskGraphData(graph, specPath),
        /at least one ui or mixed task with visualImpact/,
      );
      graph.tasks[0].workKind = 'ui';
      assert.throws(
        () => validateTaskGraphData(graph, specPath),
        /must include visualImpact/,
      );
      graph.tasks[0].visualImpact = {
        screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      };
      assert.deepEqual(validateTaskGraphData(graph, specPath).tasks[0].visualImpact.screenStates, [
        { screenId: 'SCREEN-1', states: ['ready'] },
      ]);
      graph.tasks[1].workKind = 'mixed';
      graph.tasks[1].visualImpact = structuredClone(graph.tasks[0].visualImpact);
      assert.doesNotThrow(() => validateTaskGraphData(graph, specPath));
      assert.doesNotThrow(() => validateTaskGraphData(graph));
      writeJson(graphPath, graph);
      const target = path.join(root, 'handoff-target');
      const handoff = runHandoff([
        '--project-id',
        'webhook-api-service',
        '--artifacts',
        root,
        '--target',
        target,
      ]);
      assert.equal(handoff.status, 0, `${handoff.stdout}\n${handoff.stderr}`);
      const targetArtifacts = path.join(
        target,
        '.plan2agent',
        'artifacts',
        'webhook-api-service',
      );
      assert.equal(existsSync(path.join(targetArtifacts, 'gate-b-spec', 'experience-spec.json')), true);
      assert.equal(existsSync(path.join(targetArtifacts, 'gate-b-spec', 'visual-design', 'VD-1', 'index.html')), true);
      const targetValidation = runValidator([
        '--artifact-root',
        targetArtifacts,
        '--project-id',
        'webhook-api-service',
        '--require-handoff-ready',
      ]);
      assert.equal(targetValidation.status, 0, `${targetValidation.stdout}\n${targetValidation.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('iteration init rebases approved visual artifacts with the moved Gate B bundle', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-iteration-init-'));
    try {
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const visualBundle = buildApprovedVisualBundle(root, 'webhook-api-service');
      const specPath = path.join(root, 'gate-b-spec', 'spec.json');
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      spec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'The greenfield release includes an approved operator review screen.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      spec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(specPath, spec);

      const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      for (const task of graph.tasks) task.workKind = 'non_ui';
      graph.tasks[0].workKind = 'ui';
      graph.tasks[0].visualImpact = {
        screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      };
      writeJson(graphPath, graph);

      const init = runIteration(['init', '--artifacts', root, '--iteration-id', 'iter-001']);
      assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
      const movedSpecPath = path.join(root, 'iterations', 'iter-001', 'gate-b-spec', 'spec.json');
      const movedSpec = JSON.parse(readFileSync(movedSpecPath, 'utf8'));
      assert.deepEqual(movedSpec.approval_audit.approved_artifacts, [
        'iterations/iter-001/gate-b-spec/spec.json',
        'iterations/iter-001/gate-b-spec/experience-spec.json',
      ]);
      const validation = runIteration(['validate', '--artifacts', root]);
      assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('diff-tasks emits screen/state impact without copying the final review contract into tasks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-diff-tasks-'));
    try {
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const init = runIteration(['init', '--artifacts', root, '--iteration-id', 'iter-001']);
      assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
      const iterationRoot = path.join(root, 'iterations', 'iter-001');
      const visualBundle = buildApprovedVisualBundle(iterationRoot, 'webhook-api-service');
      const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      spec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This iteration implements the operator review screen.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      spec.approval_audit.approved_artifacts.push(
        'iterations/iter-001/gate-b-spec/experience-spec.json',
      );
      writeJson(specPath, spec);
      const graphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
      rmSync(graphPath);

      const result = runIteration(['diff-tasks', '--artifacts', root]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const draftPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.draft.json');
      const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
      assert.equal(draft.tasks.every((task) => ['ui', 'non_ui', 'mixed'].includes(task.workKind)), true);
      const impactedTasks = draft.tasks.filter((task) => task.visualImpact);
      assert.equal(impactedTasks.length, 1);
      assert.deepEqual(impactedTasks[0].visualImpact.screenStates, [{ screenId: 'SCREEN-1', states: ['ready'] }]);
      assert.equal(impactedTasks[0].visualReview, undefined);
      assert.equal(validateTaskGraphData(draft, specPath), draft);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a visual-only spec change produces a UI implementation task', () => {
    const baselineSpec = {
      product: {},
      implementation: {},
      visual_experience: {
        has_visual_interface: true,
        design_scope: 'minimal',
        design_timing: 'current_iteration',
        rationale: 'The baseline uses a function-first visual treatment.',
      },
      clarifying_question_disposition: [],
    };
    const activeSpec = {
      ...baselineSpec,
      visual_experience: {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This iteration promotes the approved interface to full visual design.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: '0'.repeat(64),
      },
    };
    const visualContract = {
      required: true,
      experienceSpecRef: 'experience-spec.json',
      experienceSpecSha256: '0'.repeat(64),
      prototypeManifestRef: 'visual-design/VD-1/prototype.json',
      prototypeManifestSha256: '0'.repeat(64),
      screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      accessibilityStandard: 'WCAG 2.2 AA',
    };
    const graph = taskGraphFromSpecChanges({
      projectId: 'reviewpane',
      iterationId: 'iter-002',
      activeSpec,
      baselineSpec,
      baselineRef: 'iterations/iter-001/gate-b-spec/spec.json',
      visualContract,
    });
    const visualTask = graph.tasks.find((task) => task.visualImpact);
    assert.equal(visualTask?.targetArea, 'ui');
    assert.equal(visualTask?.workKind, 'ui');
    assert.deepEqual(visualTask?.sourceSpecRefs, ['visual_experience']);

    const splitGraph = taskGraphFromSpecChanges({
      projectId: 'reviewpane',
      iterationId: 'iter-002',
      activeSpec,
      baselineSpec,
      baselineRef: 'iterations/iter-001/gate-b-spec/spec.json',
      visualContract: {
        ...visualContract,
        screenStates: [
          { screenId: 'SCREEN-1', states: ['ready', 'error'] },
          { screenId: 'SCREEN-2', states: ['empty', 'ready'] },
        ],
      },
    });
    const splitVisualTasks = splitGraph.tasks.filter((task) => task.visualImpact);
    assert.equal(splitVisualTasks.length, 2);
    assert.deepEqual(
      splitVisualTasks.map((task) => task.visualImpact.screenStates),
      [
        [{ screenId: 'SCREEN-1', states: ['ready', 'error'] }],
        [{ screenId: 'SCREEN-2', states: ['empty', 'ready'] }],
      ],
    );
    const splitVerificationTask = splitGraph.tasks.find((task) => task.targetArea === 'verification');
    assert.deepEqual(
      splitVerificationTask.dependencies.filter((taskId) => splitVisualTasks.some((task) => task.id === taskId)),
      splitVisualTasks.map((task) => task.id),
    );

    const reuseGraph = taskGraphFromSpecChanges({
      projectId: 'reviewpane',
      iterationId: 'iter-002',
      activeSpec: {
        ...baselineSpec,
        visual_experience: {
          has_visual_interface: true,
          design_scope: 'reuse',
          design_timing: 'current_iteration',
          rationale: 'This iteration applies the approved existing design system.',
          design_system_refs: ['design-system://reviewpane'],
        },
      },
      baselineSpec,
      baselineRef: 'iterations/iter-001/gate-b-spec/spec.json',
    });
    const reuseTask = reuseGraph.tasks.find((task) => task.sourceSpecRefs.includes('visual_experience'));
    assert.equal(reuseTask?.targetArea, 'ui');
    assert.equal(reuseTask?.visualImpact, undefined);

    const classificationOnlyGraph = taskGraphFromSpecChanges({
      projectId: 'reviewpane',
      iterationId: 'iter-002',
      activeSpec: {
        ...baselineSpec,
        visual_experience: {
          has_visual_interface: false,
          design_scope: 'none',
          design_timing: 'not_applicable',
          rationale: 'This backend-only iteration has no rendered interface work.',
        },
      },
      baselineSpec: {
        product: baselineSpec.product,
        implementation: baselineSpec.implementation,
        clarifying_question_disposition: [],
      },
      baselineRef: 'iterations/iter-001/gate-b-spec/spec.json',
    });
    assert.deepEqual(classificationOnlyGraph.tasks.map((task) => task.targetArea), ['verification']);
  });

  test('workspace revisions include ordinary top-level directories outside the artifact root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-workspace-revision-'));
    try {
      const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'reviewpane');
      const applicationRunsDir = path.join(root, 'runs');
      mkdirSync(artifactRoot, { recursive: true });
      mkdirSync(applicationRunsDir, { recursive: true });
      const applicationFile = path.join(applicationRunsDir, 'review-pane.js');
      writeFileSync(applicationFile, 'export const label = "before";\n', 'utf8');
      const before = workspaceRevisionSha256(root, [artifactRoot]);
      writeFileSync(applicationFile, 'export const label = "after";\n', 'utf8');
      const after = workspaceRevisionSha256(root, [artifactRoot]);
      assert.notEqual(after, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonical workspace inference resolves artifact control-directory symlink aliases', (context) => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-canonical-workspace-symlink-'));
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const p2aRoot = path.join(workspaceRoot, '.plan2agent');
      const artifactRoot = path.join(p2aRoot, 'artifacts', 'reviewpane');
      const controlAlias = path.join(workspaceRoot, 'p2a-control-alias');
      mkdirSync(artifactRoot, { recursive: true });
      try {
        symlinkSync(p2aRoot, controlAlias, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip(`symbolic links are unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const aliasedArtifactRoot = path.join(controlAlias, 'artifacts', 'reviewpane');
      assert.equal(
        canonicalWorkspacePathForArtifactRoot(aliasedArtifactRoot),
        realpathSync(workspaceRoot),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonical workspace inference preserves a lexical workspace when .plan2agent points outside it', (context) => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-external-control-symlink-'));
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const externalP2aRoot = path.join(root, 'shared-state', '.plan2agent');
      const externalArtifactRoot = path.join(externalP2aRoot, 'artifacts', 'reviewpane');
      mkdirSync(workspaceRoot, { recursive: true });
      mkdirSync(externalArtifactRoot, { recursive: true });
      try {
        symlinkSync(
          externalP2aRoot,
          path.join(workspaceRoot, '.plan2agent'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip(`symbolic links are unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const lexicalArtifactRoot = path.join(
        workspaceRoot,
        '.plan2agent',
        'artifacts',
        'reviewpane',
      );
      assert.equal(
        canonicalWorkspacePathForArtifactRoot(lexicalArtifactRoot),
        realpathSync(workspaceRoot),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('standalone workspace revisions exclude only runs and adjacent visual evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-standalone-workspace-revision-'));
    try {
      const sourceDir = path.join(root, 'src');
      const runsDir = path.join(sourceDir, 'runs');
      const evidenceDir = path.join(sourceDir, 'visual-evidence');
      mkdirSync(runsDir, { recursive: true });
      mkdirSync(evidenceDir, { recursive: true });
      const applicationFile = path.join(sourceDir, 'app.js');
      writeFileSync(applicationFile, 'export const label = "before";\n', 'utf8');
      writeFileSync(path.join(runsDir, 'run-index.json'), '{}\n', 'utf8');
      writeFileSync(path.join(evidenceDir, 'capture.txt'), 'before\n', 'utf8');
      const excludedPaths = workspaceRevisionExcludedPaths(runsDir, null, null, root);
      const before = workspaceRevisionSha256(root, excludedPaths);
      writeFileSync(path.join(runsDir, 'run-index.json'), '{"changed":true}\n', 'utf8');
      writeFileSync(path.join(evidenceDir, 'capture.txt'), 'after\n', 'utf8');
      assert.equal(workspaceRevisionSha256(root, excludedPaths), before);
      writeFileSync(applicationFile, 'export const label = "after";\n', 'utf8');
      assert.notEqual(workspaceRevisionSha256(root, excludedPaths), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('standalone workspace revisions exclude the graph file without hiding colocated implementation files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-colocated-graph-workspace-revision-'));
    try {
      const uiDir = path.join(root, 'src', 'ui');
      const runsDir = path.join(root, 'runs');
      mkdirSync(uiDir, { recursive: true });
      mkdirSync(runsDir, { recursive: true });
      const graphPath = path.join(uiDir, 'task-graph.json');
      const applicationFile = path.join(uiDir, 'review-pane.js');
      writeFileSync(graphPath, '{"version":"before"}\n', 'utf8');
      writeFileSync(applicationFile, 'export const label = "before";\n', 'utf8');

      const excludedPaths = workspaceRevisionExcludedPaths(runsDir, null, graphPath, root);
      const before = workspaceRevisionSha256(root, excludedPaths);
      writeFileSync(graphPath, '{"version":"after"}\n', 'utf8');
      assert.equal(workspaceRevisionSha256(root, excludedPaths), before);

      writeFileSync(applicationFile, 'export const label = "after";\n', 'utf8');
      assert.notEqual(workspaceRevisionSha256(root, excludedPaths), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('graph workspace revisions include artifact-named implementation directories outside the legacy layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-artifact-named-workspace-revision-'));
    try {
      const runsDir = path.join(root, 'runs');
      const graphPath = path.join(root, 'task-graph.json');
      const implementationDir = path.join(root, 'iterations');
      mkdirSync(runsDir, { recursive: true });
      mkdirSync(implementationDir, { recursive: true });
      writeFileSync(graphPath, '{"version":"fixture"}\n', 'utf8');
      const implementationFile = path.join(implementationDir, 'review-pane.js');
      writeFileSync(implementationFile, 'export const label = "before";\n', 'utf8');

      const excludedPaths = workspaceRevisionExcludedPaths(runsDir, null, graphPath, root);
      const before = workspaceRevisionSha256(root, excludedPaths);
      writeFileSync(implementationFile, 'export const label = "after";\n', 'utf8');
      assert.notEqual(workspaceRevisionSha256(root, excludedPaths), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspace revisions include the contents of symbolic-link file targets', (context) => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-symlink-workspace-revision-'));
    try {
      const workspace = path.join(root, 'workspace');
      const sharedFile = path.join(root, 'shared-theme.css');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(sharedFile, ':root { color: red; }\n', 'utf8');
      try {
        symlinkSync(sharedFile, path.join(workspace, 'theme.css'));
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip(`symbolic links are unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const before = workspaceRevisionSha256(workspace);
      writeFileSync(sharedFile, ':root { color: blue; }\n', 'utf8');
      assert.notEqual(workspaceRevisionSha256(workspace), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspace revisions reject symbolic-link directories outside the workspace', (context) => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-external-symlink-workspace-revision-'));
    try {
      const workspace = path.join(root, 'workspace');
      const sharedDirectory = path.join(root, 'shared-ui');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(sharedDirectory, { recursive: true });
      writeFileSync(path.join(sharedDirectory, 'theme.css'), ':root { color: red; }\n', 'utf8');
      try {
        symlinkSync(sharedDirectory, path.join(workspace, 'shared-ui'), 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip(`symbolic links are unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      assert.throws(
        () => workspaceRevisionSha256(workspace),
        /cannot follow symbolic-link directory shared-ui outside the workspace/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspace revisions preserve ignored-directory exclusions through symbolic-link aliases', (context) => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-ignored-symlink-workspace-revision-'));
    try {
      const gitDirectory = path.join(root, '.git');
      mkdirSync(gitDirectory, { recursive: true });
      writeFileSync(path.join(root, 'app.js'), 'export const ready = true;\n', 'utf8');
      writeFileSync(path.join(gitDirectory, 'HEAD'), 'before\n', 'utf8');
      try {
        symlinkSync(gitDirectory, path.join(root, 'git-metadata'), 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip(`symbolic links are unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const before = workspaceRevisionSha256(root);
      writeFileSync(path.join(gitDirectory, 'HEAD'), 'after\n', 'utf8');
      assert.equal(workspaceRevisionSha256(root), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('managed run revision exclusions are independent of the CLI locator', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-managed-workspace-revision-'));
    try {
      const artifactRoot = path.join(root, 'control', 'reviewpane');
      const runsDir = path.join(artifactRoot, 'runs');
      const graphPath = path.join(
        artifactRoot,
        'iterations',
        'iter-001',
        'gate-c-task-graph',
        'task-graph.json',
      );
      const applicationFile = path.join(root, 'src', 'review-pane.js');
      mkdirSync(runsDir, { recursive: true });
      mkdirSync(path.dirname(graphPath), { recursive: true });
      mkdirSync(path.dirname(applicationFile), { recursive: true });
      writeFileSync(graphPath, '{"control":"before"}\n', 'utf8');
      writeFileSync(applicationFile, 'export const label = "before";\n', 'utf8');
      const run = {
        sourceLayout: 'iteration',
        taskGraphRef: path.relative(artifactRoot, graphPath),
        workspacePath: root,
      };
      const inferred = workspaceRevisionExcludedPathsForRun(runsDir, run, {
        workspacePath: root,
      });
      const explicit = workspaceRevisionExcludedPathsForRun(runsDir, run, {
        artifactRoot,
        graphPath,
        workspacePath: root,
      });
      const before = workspaceRevisionSha256(root, inferred);
      assert.equal(workspaceRevisionSha256(root, explicit), before);
      writeFileSync(graphPath, '{"control":"after"}\n', 'utf8');
      assert.equal(workspaceRevisionSha256(root, inferred), before);
      writeFileSync(applicationFile, 'export const label = "after";\n', 'utf8');
      assert.notEqual(workspaceRevisionSha256(root, inferred), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('legacy v1 runs remain valid and upgrade their task contract when finished', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-legacy-run-contract-'));
    try {
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
      const runsDir = path.join(root, 'runs');
      const runId = 'run-legacy-contract';
      let result = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', root,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const runPath = runFilePath(runsDir, runId);
      const legacyStartedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      legacyStartedRun.schema_version = 'p2a.run.v1';
      delete legacyStartedRun.taskContractSha256;
      legacyStartedRun.verification = [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: legacyStartedRun.startedAt,
        finishedAt: legacyStartedRun.startedAt,
        stdoutTail: 'passed',
        stderrTail: '',
        source: 'command',
      }];
      writeJson(runPath, legacyStartedRun);

      result = runRuns(['finish', '--graph', graphPath, '--run-id', runId, '--status', 'finished']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const upgradedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      assert.equal(upgradedRun.schema_version, 'p2a.run.v2');
      assert.match(upgradedRun.taskContractSha256, /^[a-f0-9]{64}$/);
      assert.doesNotThrow(() => validateRunsDir(runsDir));

      upgradedRun.schema_version = 'p2a.run.v1';
      delete upgradedRun.taskContractSha256;
      writeJson(runPath, upgradedRun);
      assert.doesNotThrow(() => validateRunsDir(runsDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('external visual source roots stay valid when implementation finishes without visual evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-finish-seal-'));
    try {
      const sourceRoot = path.join(root, 'approved-source');
      const graphRoot = path.join(root, 'detached-graph');
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), sourceRoot, { recursive: true });
      const sourceGraphPath = path.join(sourceRoot, 'gate-c-task-graph', 'task-graph.json');
      const graphPath = path.join(graphRoot, 'gate-c-task-graph', 'task-graph.json');
      const visualBundle = buildApprovedVisualBundle(sourceRoot, 'webhook-api-service');
      const sourceSpec = JSON.parse(readFileSync(visualBundle.specPath, 'utf8'));
      sourceSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This fixture verifies evidence sealing during visual run finish.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      sourceSpec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(visualBundle.specPath, sourceSpec);
      const graph = JSON.parse(readFileSync(sourceGraphPath, 'utf8'));
      graph.sourceSpec = visualBundle.specPath;
      const task = graph.tasks.find((candidate) => candidate.id === 'task-001');
      for (const candidate of graph.tasks) candidate.workKind = 'non_ui';
      task.workKind = 'ui';
      task.visualImpact = {
        screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      };
      writeJson(graphPath, graph);
      const workspacePath = root;
      writeFileSync(path.join(workspacePath, 'review-pane.js'), 'export const ready = true;\n', 'utf8');

      const runId = 'run-visual-finish-seal';
      let result = runTasks(['start', '--graph', graphPath, 'task-001']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      result = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', workspacePath,
        '--workspace-ref', 'visual-task-done-fixture',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const runsDir = path.join(graphRoot, 'runs');
      const runPath = runFilePath(runsDir, runId);
      result = runRuns([
        'record',
        '--graph', graphPath,
        '--run-id', runId,
        '--visual-feedback', 'concern',
        '--visual-feedback-concern', 'Check the compact viewport before integration.',
        '--visual-feedback-note', 'Informational early review; it is not a completion gate.',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const startedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      assert.deepEqual(startedRun.visualFeedback?.map((item) => item.verdict), ['concern']);
      startedRun.verification = [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: startedRun.startedAt,
        finishedAt: startedRun.startedAt,
        stdoutTail: 'passed',
        stderrTail: '',
        source: 'command',
      }];
      writeJson(runPath, startedRun);
      result = runRuns(['finish', '--graph', graphPath, '--run-id', runId, '--status', 'finished']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const finishedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      assert.equal(finishedRun.visualReview, undefined);
      assert.equal(finishedRun.visualReviewEvidenceSha256, undefined);
      assert.doesNotThrow(() => validateRunsDir(runsDir));
      result = runTasks(['done', '--graph', graphPath, 'task-001']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('p2a execute review starts and finishes a canonical no-change run for a done visual task', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-final-visual-review-cli-'));
    try {
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const visualBundle = buildApprovedVisualBundle(root, 'webhook-api-service');
      const sourceSpec = JSON.parse(readFileSync(visualBundle.specPath, 'utf8'));
      sourceSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This fixture exercises the supported final review CLI path.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      sourceSpec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(visualBundle.specPath, sourceSpec);
      const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      const task = graph.tasks.find((candidate) => candidate.id === 'task-001');
      for (const candidate of graph.tasks) candidate.workKind = 'non_ui';
      task.status = 'done';
      task.workKind = 'ui';
      task.visualImpact = {
        screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      };
      writeJson(graphPath, graph);

      let result = runExecute([
        'review',
        '--graph', graphPath,
        '--task', task.id,
        '--run-id', 'run-final-visual-review-too-early',
        '--workspace', root,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /requires every iteration task to be done; unfinished task\(s\):/,
      );
      for (const candidate of graph.tasks) candidate.status = 'done';
      writeJson(graphPath, graph);

      const runId = 'run-final-visual-review-cli';
      result = runP2a([
        'execute', 'review',
        '--graph', graphPath,
        '--task', task.id,
        '--run-id', runId,
        '--agent-tool', 'gemini',
        '--workspace', root,
        '--workspace-ref', 'visual-task-done-fixture',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Plan2Agent final visual review/);
      assert.match(result.stdout, /changedFiles: 0/);
      assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].status, 'done');

      const runsDir = path.join(root, 'runs');
      const runPath = runFilePath(runsDir, runId);
      const startedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      assert.equal(startedRun.status, 'started');
      assert.equal(startedRun.runKind, 'final_visual_review');
      assert.equal(startedRun.isolation.mode, 'none');
      assert.equal(startedRun.workspacePath, root);
      assert.deepEqual(startedRun.changedFiles, []);

      const resumedReview = runExecute([
        'resume',
        '--graph', graphPath,
        '--run-id', runId,
      ]);
      assert.equal(resumedReview.status, 0, `${resumedReview.stdout}\n${resumedReview.stderr}`);
      assert.match(resumedReview.stdout, /Plan2Agent final visual review/);
      assert.doesNotMatch(resumedReview.stdout, /Manual launcher prompt|Implement Plan2Agent task/);

      result = runRuns(['revision', '--runs', runsDir, '--run-id', runId]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const workspaceRevision = result.stdout.trim();
      const evidenceDir = path.join(root, 'visual-evidence', startedRun.iterationId, runId);
      mkdirSync(evidenceDir, { recursive: true });
      const screenshotPath = path.join(evidenceDir, 'screen-1-ready-desktop.png');
      const accessibilityPath = path.join(evidenceDir, 'accessibility.json');
      writePng(screenshotPath, 1440, 900);
      writeJson(accessibilityPath, {
        schema_version: 'p2a.visual_accessibility_report.v1',
        tool: 'axe-core',
        standard: 'WCAG 2.2 AA',
        scanned_at: startedRun.startedAt,
        page_urls: ['http://127.0.0.1:4173/reviews/1'],
        violations: [],
      });
      writeJson(
        runSidecarPath(runsDir, runId, '.visual-review.json'),
        validReview(runId, {
          artifactSha256: sha256(screenshotPath),
          reportSha256: sha256(accessibilityPath),
        }, startedRun.iterationId, {
          reviewedAt: startedRun.startedAt,
          capturedAt: startedRun.startedAt,
          workspaceRevisionSha256: workspaceRevision,
        }),
      );

      result = runP2a([
        'execute', 'finish',
        '--graph', graphPath,
        '--run-id', runId,
        '--test-command', 'true',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /task-001 remains done after final visual review/);
      const finishedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      assert.equal(finishedRun.status, 'finished');
      assert.deepEqual(finishedRun.changedFiles, []);
      assert.match(finishedRun.visualReviewEvidenceSha256, /^[a-f0-9]{64}$/);

      const isolatedAttempt = runExecute([
        'review',
        '--graph', graphPath,
        '--task', task.id,
        '--run-id', 'run-final-visual-review-isolated',
        '--workspace', root,
        '--isolation', 'worktree',
      ]);
      assert.notEqual(isolatedAttempt.status, 0);
      assert.match(`${isolatedAttempt.stdout}\n${isolatedAttempt.stderr}`, /must use --isolation none/);

      const lowLevelChangedReview = runRuns([
        'start',
        '--graph', graphPath,
        '--task', task.id,
        '--run-id', 'run-final-visual-review-low-level-changed',
        '--agent-tool', 'codex',
        '--run-kind', 'final_visual_review',
        '--workspace', root,
        '--changed-file', 'src/changed-during-review.js',
      ]);
      assert.notEqual(lowLevelChangedReview.status, 0);
      assert.match(
        `${lowLevelChangedReview.stdout}\n${lowLevelChangedReview.stderr}`,
        /does not allow --changed-file/,
      );

      const blockedRunId = 'run-final-visual-review-blocked';
      result = runP2a([
        'execute', 'review',
        '--graph', graphPath,
        '--task', task.id,
        '--run-id', blockedRunId,
        '--workspace', root,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      result = runP2a([
        'execute', 'finish',
        '--graph', graphPath,
        '--run-id', blockedRunId,
        '--status', 'blocked',
        '--failure-class', 'implementation_incomplete',
        '--repro-step', 'Open the final review capture and observe the visual defect.',
        '--localization', 'The approved screen state does not match the canonical application.',
        '--guard', 'Implement the correction before starting another final review.',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Reopening task task-001 after blocked final visual review/);
      assert.equal(
        JSON.parse(readFileSync(graphPath, 'utf8')).tasks.find((candidate) => candidate.id === task.id).status,
        'todo',
      );
      const remediationPlan = runExecute([
        'plan',
        '--graph', graphPath,
        '--task', task.id,
        '--workspace', root,
      ]);
      assert.equal(remediationPlan.status, 0, `${remediationPlan.stdout}\n${remediationPlan.stderr}`);
      assert.match(remediationPlan.stdout, /Prompt preview command/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('p2a execute review resolves the managed artifact root to its canonical project workspace', () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-managed-final-visual-review-'));
    try {
      const artifactRoot = path.join(
        workspaceRoot,
        '.plan2agent',
        'artifacts',
        'webhook-api-service',
      );
      mkdirSync(path.dirname(artifactRoot), { recursive: true });
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
      const visualBundle = buildApprovedVisualBundle(artifactRoot, 'webhook-api-service');
      const sourceSpec = JSON.parse(readFileSync(visualBundle.specPath, 'utf8'));
      sourceSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This fixture verifies canonical managed-workspace inference.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      sourceSpec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(visualBundle.specPath, sourceSpec);
      const sourceGraphPath = path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
      const sourceGraph = JSON.parse(readFileSync(sourceGraphPath, 'utf8'));
      const sourceTask = sourceGraph.tasks.find((task) => task.id === 'task-001');
      for (const task of sourceGraph.tasks) task.workKind = 'non_ui';
      sourceTask.workKind = 'ui';
      sourceTask.visualImpact = {
        screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      };
      writeJson(sourceGraphPath, sourceGraph);

      let result = runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', 'iter-001']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const graphPath = path.join(
        artifactRoot,
        'iterations',
        'iter-001',
        'gate-c-task-graph',
        'task-graph.json',
      );
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      for (const task of graph.tasks) task.status = 'done';
      writeJson(graphPath, graph);
      const applicationPath = path.join(workspaceRoot, 'src', 'application.js');
      mkdirSync(path.dirname(applicationPath), { recursive: true });
      writeFileSync(applicationPath, 'export const reviewed = true;\n', 'utf8');

      result = runExecute([
        'review',
        '--artifacts', artifactRoot,
        '--task', 'task-001',
        '--run-id', 'run-managed-review-wrong-workspace',
        '--workspace', artifactRoot,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /canonical integration workspace/);

      const runId = 'run-managed-final-visual-review';
      result = runExecute([
        'review',
        '--artifacts', artifactRoot,
        '--task', 'task-001',
        '--run-id', runId,
        '--workspace-ref', 'managed-canonical-workspace',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const run = JSON.parse(readFileSync(runFilePath(path.join(artifactRoot, 'runs'), runId), 'utf8'));
      assert.equal(realpathSync(run.workspacePath), realpathSync(workspaceRoot));
      assert.equal(run.runKind, 'final_visual_review');
      assert.equal(run.isolation.mode, 'none');
      assert.deepEqual(run.changedFiles, []);
      assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].status, 'done');

      const runsDir = path.join(artifactRoot, 'runs');
      result = runRuns(['revision', '--artifacts', artifactRoot, '--run-id', runId]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const workspaceRevision = result.stdout.trim();
      const evidenceDir = path.join(artifactRoot, 'visual-evidence', run.iterationId, runId);
      mkdirSync(evidenceDir, { recursive: true });
      const screenshotPath = path.join(evidenceDir, 'screen-1-ready-desktop.png');
      const accessibilityPath = path.join(evidenceDir, 'accessibility.json');
      writePng(screenshotPath, 1440, 900);
      writeJson(accessibilityPath, {
        schema_version: 'p2a.visual_accessibility_report.v1',
        tool: 'axe-core',
        standard: 'WCAG 2.2 AA',
        scanned_at: run.startedAt,
        page_urls: ['http://127.0.0.1:4173/reviews/1'],
        violations: [],
      });
      const reviewPath = runSidecarPath(runsDir, runId, '.visual-review.json');
      writeJson(
        reviewPath,
        validReview(runId, {
          artifactSha256: sha256(screenshotPath),
          reportSha256: sha256(accessibilityPath),
        }, run.iterationId, {
          reviewedAt: run.startedAt,
          capturedAt: run.startedAt,
          workspaceRef: run.workspaceRef,
          workspaceRevisionSha256: workspaceRevision,
        }),
      );
      result = runExecute([
        'finish',
        '--artifacts', artifactRoot,
        '--run-id', runId,
        '--test-command', 'true',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const nextResult = runP2a([
        'next',
        '--target', workspaceRoot,
        '--project-id', 'webhook-api-service',
        '--json',
      ]);
      assert.equal(nextResult.status, 0, `${nextResult.stdout}\n${nextResult.stderr}`);
      const nextPayload = JSON.parse(nextResult.stdout);
      assert.equal(nextPayload.state, 'iteration_ready_to_close');
      assert.deepEqual(nextPayload.command.argv, [
        'iteration',
        'close',
        '--artifacts',
        artifactRoot,
      ]);

      const finishedRunPath = runFilePath(runsDir, runId);
      const finishedRun = JSON.parse(readFileSync(finishedRunPath, 'utf8'));
      delete finishedRun.runKind;
      writeJson(finishedRunPath, finishedRun);
      let staleNext = runP2a([
        'next',
        '--target', workspaceRoot,
        '--project-id', 'webhook-api-service',
        '--json',
      ]);
      assert.equal(staleNext.status, 0, `${staleNext.stdout}\n${staleNext.stderr}`);
      assert.equal(JSON.parse(staleNext.stdout).state, 'invalid_run_evidence');

      finishedRun.runKind = 'final_visual_review';
      writeJson(finishedRunPath, finishedRun);
      writeFileSync(applicationPath, 'export const reviewed = "stale";\n', 'utf8');
      staleNext = runP2a([
        'next',
        '--target', workspaceRoot,
        '--project-id', 'webhook-api-service',
        '--json',
      ]);
      assert.equal(staleNext.status, 0, `${staleNext.stdout}\n${staleNext.stderr}`);
      assert.equal(JSON.parse(staleNext.stdout).state, 'final_visual_review_required');

      writeFileSync(applicationPath, 'export const reviewed = true;\n', 'utf8');
      const driftedReview = JSON.parse(readFileSync(reviewPath, 'utf8'));
      driftedReview.note = 'Evidence changed after the run was sealed.';
      writeJson(reviewPath, driftedReview);
      staleNext = runP2a([
        'next',
        '--target', workspaceRoot,
        '--project-id', 'webhook-api-service',
        '--json',
      ]);
      assert.equal(staleNext.status, 0, `${staleNext.stdout}\n${staleNext.stderr}`);
      const invalidEvidenceNext = JSON.parse(staleNext.stdout);
      assert.equal(invalidEvidenceNext.state, 'invalid_run_evidence');
      assert.deepEqual(invalidEvidenceNext.command.argv, [
        'runs',
        'validate',
        '--artifacts',
        artifactRoot,
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('implementation completion is independent from the single close-ready visual review', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-task-done-'));
    try {
      const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), root, { recursive: true });
      const visualBundle = buildApprovedVisualBundle(root, 'webhook-api-service');
      const sourceSpec = JSON.parse(readFileSync(visualBundle.specPath, 'utf8'));
      sourceSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'This fixture implements the approved operator review screen.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: sha256(visualBundle.experiencePath),
      };
      sourceSpec.approval_audit.approved_artifacts.push('gate-b-spec/experience-spec.json');
      writeJson(visualBundle.specPath, sourceSpec);
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      const task = graph.tasks.find((candidate) => candidate.id === 'task-001');
      for (const candidate of graph.tasks) candidate.workKind = 'non_ui';
      task.workKind = 'ui';
      task.visualImpact = {
        screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
      };
      writeJson(graphPath, graph);

      let result = runTasks(['start', '--graph', graphPath, 'task-001']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const runId = 'run-visual-task-done';
      result = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', root,
        '--workspace-ref', 'visual-task-done-fixture',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const runsDir = path.join(root, 'runs');
      const runPath = runFilePath(runsDir, runId);
      const run = JSON.parse(readFileSync(runPath, 'utf8'));
      const finishedAt = new Date(Date.parse(run.startedAt) + 1000).toISOString();
      run.status = 'finished';
      run.updatedAt = finishedAt;
      run.finishedAt = finishedAt;
      run.changedFiles = ['src/review-pane.js'];
      run.verification = [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: run.startedAt,
        finishedAt,
        stdoutTail: 'passed',
        stderrTail: '',
        source: 'command',
      }];
      writeJson(runPath, run);
      const indexPath = path.join(runsDir, 'run-index.json');
      const runIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      runIndex.runs[0].status = 'finished';
      runIndex.runs[0].finishedAt = finishedAt;
      writeJson(indexPath, runIndex);

      result = runTasks(['done', '--graph', graphPath, 'task-001']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const laterRunId = 'run-nonvisual-after-review';
      result = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-002',
        '--run-id', laterRunId,
        '--agent-tool', 'codex',
        '--workspace', root,
        '--workspace-ref', 'visual-task-done-fixture',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const laterRunPath = runFilePath(runsDir, laterRunId);
      const laterRun = JSON.parse(readFileSync(laterRunPath, 'utf8'));
      const laterFinishedAt = new Date(Date.parse(laterRun.startedAt) + 2000).toISOString();
      laterRun.status = 'finished';
      laterRun.updatedAt = laterFinishedAt;
      laterRun.finishedAt = laterFinishedAt;
      laterRun.changedFiles = ['src/shared-layout.css'];
      laterRun.verification = [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: laterRun.startedAt,
        finishedAt: laterFinishedAt,
        stdoutTail: 'passed',
        stderrTail: '',
        source: 'command',
      }];
      writeJson(laterRunPath, laterRun);
      const laterIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      const laterIndexEntry = laterIndex.runs.find((entry) => entry.runId === laterRunId);
      laterIndexEntry.status = 'finished';
      laterIndexEntry.finishedAt = laterFinishedAt;
      writeJson(indexPath, laterIndex);
      assert.throws(
        () => validateCloseReadyVisualEvidence({
          artifactRoot: root,
          activeIteration: run.iterationId,
          taskGraphPath: graphPath,
          taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
        }),
        /latest run for the active iteration to be finished/,
      );

      const integratedUiPath = path.join(root, 'src', 'integrated-ui.js');
      mkdirSync(path.dirname(integratedUiPath), { recursive: true });
      writeFileSync(integratedUiPath, 'export const integrated = true;\n', 'utf8');
      const earlyReview = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', 'run-final-visual-review-too-early-low-level',
        '--agent-tool', 'codex',
        '--run-kind', 'final_visual_review',
        '--workspace', root,
        '--workspace-ref', 'visual-task-done-fixture',
      ]);
      assert.notEqual(earlyReview.status, 0);
      assert.match(
        `${earlyReview.stdout}\n${earlyReview.stderr}`,
        /requires every iteration task to be done/,
      );
      const completedGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
      for (const candidate of completedGraph.tasks) candidate.status = 'done';
      writeJson(graphPath, completedGraph);
      const finalReviewRunId = 'run-final-visual-review';
      result = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', finalReviewRunId,
        '--agent-tool', 'codex',
        '--run-kind', 'final_visual_review',
        '--workspace', root,
        '--workspace-ref', 'visual-task-done-fixture',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const finalReviewRunPath = runFilePath(runsDir, finalReviewRunId);
      const finalReviewRun = JSON.parse(readFileSync(finalReviewRunPath, 'utf8'));
      result = runRuns(['revision', '--runs', runsDir, '--run-id', finalReviewRunId]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      finalReviewRun.workspaceRevisionSha256 = result.stdout.trim();
      const finalReviewedAt = new Date(
        Math.max(Date.parse(finalReviewRun.startedAt), Date.parse(laterFinishedAt)) + 2000,
      ).toISOString();
      finalReviewRun.status = 'finished';
      finalReviewRun.updatedAt = finalReviewedAt;
      finalReviewRun.finishedAt = finalReviewedAt;
      finalReviewRun.changedFiles = [];
      finalReviewRun.verification = [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: finalReviewRun.startedAt,
        finishedAt: finalReviewedAt,
        stdoutTail: 'passed',
        stderrTail: '',
        source: 'command',
      }];
      writeJson(finalReviewRunPath, finalReviewRun);
      const finalIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      const finalIndexEntry = finalIndex.runs.find((entry) => entry.runId === finalReviewRunId);
      finalIndexEntry.status = 'finished';
      finalIndexEntry.finishedAt = finalReviewedAt;
      writeJson(indexPath, finalIndex);
      const finalEvidenceDir = path.join(root, 'visual-evidence', run.iterationId, finalReviewRunId);
      mkdirSync(finalEvidenceDir, { recursive: true });
      const finalScreenshotPath = path.join(finalEvidenceDir, 'screen-1-ready-desktop.png');
      const finalAccessibilityPath = path.join(finalEvidenceDir, 'accessibility.json');
      writePng(finalScreenshotPath, 1440, 900);
      writeJson(finalAccessibilityPath, {
        schema_version: 'p2a.visual_accessibility_report.v1',
        tool: 'axe-core',
        standard: 'WCAG 2.2 AA',
        scanned_at: finalReviewedAt,
        page_urls: ['http://127.0.0.1:4173/reviews/1'],
        violations: [],
      });
      const finalReviewSidecarPath = runSidecarPath(runsDir, finalReviewRunId, '.visual-review.json');
      writeJson(
        finalReviewSidecarPath,
        validReview(finalReviewRunId, {
          artifactSha256: sha256(finalScreenshotPath),
          reportSha256: sha256(finalAccessibilityPath),
        }, run.iterationId, {
          reviewedAt: finalReviewedAt,
          capturedAt: finalReviewedAt,
          workspaceRevisionSha256: finalReviewRun.workspaceRevisionSha256,
        }),
      );
      finalReviewRun.visualReviewEvidenceSha256 = sha256(finalReviewSidecarPath);
      writeJson(finalReviewRunPath, finalReviewRun);
      const wrongWorkspaceReview = JSON.parse(readFileSync(finalReviewSidecarPath, 'utf8'));
      wrongWorkspaceReview.workspace_ref = 'stale-branch-workspace';
      writeJson(finalReviewSidecarPath, wrongWorkspaceReview);
      assert.throws(
        () => validateRunsDir(runsDir),
        /visual review workspace_ref must be "visual-task-done-fixture"/,
      );
      writeJson(
        finalReviewSidecarPath,
        validReview(finalReviewRunId, {
          artifactSha256: sha256(finalScreenshotPath),
          reportSha256: sha256(finalAccessibilityPath),
        }, run.iterationId, {
          reviewedAt: finalReviewedAt,
          capturedAt: finalReviewedAt,
          workspaceRevisionSha256: finalReviewRun.workspaceRevisionSha256,
        }),
      );
      writeFileSync(integratedUiPath, 'export const integrated = "changed-after-capture";\n', 'utf8');
      assert.throws(
        () => validateCloseReadyVisualEvidence({
          artifactRoot: root,
          activeIteration: run.iterationId,
          taskGraphPath: graphPath,
          taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
        }),
        /match the current canonical workspace revision/,
      );
      writeFileSync(integratedUiPath, 'export const integrated = true;\n', 'utf8');
      const staleWorkspacePath = mkdtempSync(path.join(tmpdir(), 'p2a-stale-branch-workspace-'));
      const staleWorkspaceRun = structuredClone(finalReviewRun);
      staleWorkspaceRun.workspacePath = staleWorkspacePath;
      writeJson(finalReviewRunPath, staleWorkspaceRun);
      assert.throws(
        () => validateCloseReadyVisualEvidence({
          artifactRoot: root,
          activeIteration: run.iterationId,
          taskGraphPath: graphPath,
          taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
        }),
        /review the canonical integration workspace/,
      );
      writeJson(finalReviewRunPath, finalReviewRun);
      rmSync(staleWorkspacePath, { recursive: true, force: true });
      assert.equal(validateCloseReadyVisualEvidence({
        artifactRoot: root,
        activeIteration: run.iterationId,
        taskGraphPath: graphPath,
        taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
      }), 1);

      const isolatedFinishedRun = structuredClone(laterRun);
      isolatedFinishedRun.runId = 'run-nonvisual-finished-isolated-after-review';
      isolatedFinishedRun.workspaceRef = 'unmerged-worktree';
      isolatedFinishedRun.workspacePath = path.join(root, 'unmerged-worktree');
      isolatedFinishedRun.isolation = {
        mode: 'worktree',
        branch: 'p2a/task-002-unmerged',
        worktree: isolatedFinishedRun.workspacePath,
        baseRef: 'HEAD',
        created: false,
        createCommand: null,
        createExitCode: null,
        createOutputTail: null,
      };
      isolatedFinishedRun.updatedAt = new Date(Date.parse(finalReviewedAt) + 1000).toISOString();
      isolatedFinishedRun.finishedAt = isolatedFinishedRun.updatedAt;
      isolatedFinishedRun.changedFiles = ['src/unmerged-worktree.css'];
      const isolatedFinishedRef = canonicalRunRef(isolatedFinishedRun);
      writeJson(path.join(runsDir, isolatedFinishedRef), isolatedFinishedRun);
      const isolatedFinishedIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      isolatedFinishedIndex.runs.push({
        runId: isolatedFinishedRun.runId,
        taskId: isolatedFinishedRun.taskId,
        iterationId: isolatedFinishedRun.iterationId,
        status: isolatedFinishedRun.status,
        agentTool: isolatedFinishedRun.agentTool,
        workspaceRef: isolatedFinishedRun.workspaceRef,
        taskGraphRef: isolatedFinishedRun.taskGraphRef,
        runRef: isolatedFinishedRef,
        startedAt: isolatedFinishedRun.startedAt,
        finishedAt: isolatedFinishedRun.finishedAt,
      });
      const isolatedFinishedTaskIndex = isolatedFinishedIndex.tasks.find(
        (entry) => entry.taskId === isolatedFinishedRun.taskId,
      );
      isolatedFinishedTaskIndex.runIds.push(isolatedFinishedRun.runId);
      isolatedFinishedTaskIndex.latestRunId = isolatedFinishedRun.runId;
      writeJson(indexPath, isolatedFinishedIndex);
      assert.equal(validateCloseReadyVisualEvidence({
        artifactRoot: root,
        activeIteration: run.iterationId,
        taskGraphPath: graphPath,
        taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
      }), 1);

      const failedNonvisualRun = structuredClone(laterRun);
      failedNonvisualRun.runId = 'run-nonvisual-failed-after-review';
      failedNonvisualRun.status = 'failed';
      failedNonvisualRun.updatedAt = new Date(Date.parse(finalReviewedAt) + 1000).toISOString();
      failedNonvisualRun.finishedAt = failedNonvisualRun.updatedAt;
      failedNonvisualRun.changedFiles = ['src/isolated-failed-worktree.css'];
      failedNonvisualRun.reproduction = {
        steps: ['Re-run the isolated nonvisual task.'],
        commands: [],
        notes: [],
      };
      failedNonvisualRun.localization = {
        findings: ['The change never reached the canonical integration workspace.'],
        files: ['src/isolated-failed-worktree.css'],
      };
      failedNonvisualRun.guard = {
        checks: ['Only finished runs can invalidate canonical visual evidence.'],
        notes: [],
      };
      failedNonvisualRun.failure = {
        class: 'verification_failed',
        retryable: 'after_fix',
        needsUserDecision: false,
        source: 'owner',
      };
      const failedNonvisualRef = canonicalRunRef(failedNonvisualRun);
      writeJson(path.join(runsDir, failedNonvisualRef), failedNonvisualRun);
      const failedNonvisualIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      failedNonvisualIndex.runs.push({
        runId: failedNonvisualRun.runId,
        taskId: failedNonvisualRun.taskId,
        iterationId: failedNonvisualRun.iterationId,
        status: failedNonvisualRun.status,
        agentTool: failedNonvisualRun.agentTool,
        workspaceRef: failedNonvisualRun.workspaceRef,
        taskGraphRef: failedNonvisualRun.taskGraphRef,
        runRef: failedNonvisualRef,
        startedAt: failedNonvisualRun.startedAt,
        finishedAt: failedNonvisualRun.finishedAt,
      });
      const failedNonvisualTaskIndex = failedNonvisualIndex.tasks.find(
        (entry) => entry.taskId === failedNonvisualRun.taskId,
      );
      failedNonvisualTaskIndex.runIds.push(failedNonvisualRun.runId);
      failedNonvisualTaskIndex.latestRunId = failedNonvisualRun.runId;
      writeJson(indexPath, failedNonvisualIndex);
      assert.equal(validateCloseReadyVisualEvidence({
        artifactRoot: root,
        activeIteration: run.iterationId,
        taskGraphPath: graphPath,
        taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
      }), 1);

      const tiedFailedRun = structuredClone(finalReviewRun);
      tiedFailedRun.runId = 'run-final-visual-review-failed-tie';
      tiedFailedRun.status = 'failed';
      tiedFailedRun.updatedAt = finalReviewedAt;
      tiedFailedRun.finishedAt = finalReviewedAt;
      tiedFailedRun.changedFiles = [];
      delete tiedFailedRun.visualReviewEvidenceSha256;
      tiedFailedRun.reproduction = {
        steps: ['Re-run the final visual review.'],
        commands: [],
        notes: [],
      };
      tiedFailedRun.localization = {
        findings: ['The later run failed at the same recorded millisecond.'],
        files: [],
      };
      tiedFailedRun.guard = {
        checks: ['Use run-index order to break equal timestamp ties.'],
        notes: [],
      };
      tiedFailedRun.failure = {
        class: 'verification_failed',
        retryable: 'after_fix',
        needsUserDecision: false,
        source: 'owner',
      };
      const tiedFailedRef = canonicalRunRef(tiedFailedRun);
      writeJson(path.join(runsDir, tiedFailedRef), tiedFailedRun);
      const tiedIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      tiedIndex.runs.push({
        runId: tiedFailedRun.runId,
        taskId: tiedFailedRun.taskId,
        iterationId: tiedFailedRun.iterationId,
        status: tiedFailedRun.status,
        agentTool: tiedFailedRun.agentTool,
        workspaceRef: tiedFailedRun.workspaceRef,
        taskGraphRef: tiedFailedRun.taskGraphRef,
        runRef: tiedFailedRef,
        startedAt: tiedFailedRun.startedAt,
        finishedAt: tiedFailedRun.finishedAt,
      });
      const tiedTaskIndex = tiedIndex.tasks.find((entry) => entry.taskId === tiedFailedRun.taskId);
      tiedTaskIndex.runIds.push(tiedFailedRun.runId);
      tiedTaskIndex.latestRunId = tiedFailedRun.runId;
      writeJson(indexPath, tiedIndex);
      assert.throws(
        () => validateCloseReadyVisualEvidence({
          artifactRoot: root,
          activeIteration: run.iterationId,
          taskGraphPath: graphPath,
          taskGraph: JSON.parse(readFileSync(graphPath, 'utf8')),
        }),
        /latest run for the active iteration to be finished/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the final visual review run cannot finish without confirming evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'p2a-visual-run-'));
    try {
      const visualBundle = buildApprovedVisualBundle(root);
      const run = {
        runId: 'run-task-001-001',
        taskId: 'task-001',
        iterationId: 'iter-001',
        runKind: 'final_visual_review',
        startedAt: '2026-08-01T00:00:00.000Z',
        projectId: 'reviewpane',
        workspaceRef: 'visual-task-done-fixture',
        workspaceRevisionSha256: '0'.repeat(64),
        sourceSpecRef: 'gate-b-spec/spec.json',
        taskGraphRef: 'gate-c-task-graph/task-graph.json',
        visualReview: {
          required: true,
          experienceSpecRef: 'experience-spec.json',
          experienceSpecSha256: sha256(visualBundle.experiencePath),
          prototypeManifestRef: 'visual-design/VD-1/prototype.json',
          prototypeManifestSha256: sha256(visualBundle.prototypePath),
          screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
          viewports: [{ name: 'desktop', width: 1440, height: 900 }],
          accessibilityStandard: 'WCAG 2.2 AA',
        },
      };
      assert.throws(() => readRequiredVisualReview(root, run, { artifactRoot: root }), /visual review is required/);
      const evidenceDir = path.join(root, 'visual-evidence', run.iterationId, run.runId);
      mkdirSync(evidenceDir, { recursive: true });
      const screenshotPath = path.join(evidenceDir, 'screen-1-ready-desktop.png');
      const accessibilityPath = path.join(evidenceDir, 'accessibility.json');
      writePng(screenshotPath, 1440, 900);
      writeJson(accessibilityPath, {
        schema_version: 'p2a.visual_accessibility_report.v1',
        tool: 'axe-core',
        standard: 'WCAG 2.2 AA',
        scanned_at: '2026-08-01T00:59:00.000Z',
        page_urls: ['http://127.0.0.1:4173/reviews/1'],
        violations: [],
      });
      const evidence = {
        artifactSha256: sha256(screenshotPath),
        reportSha256: sha256(accessibilityPath),
      };
      const reviewPath = path.join(root, `${run.runId}.visual-review.json`);
      writeJson(reviewPath, validReview(run.runId, evidence));
      assert.equal(readRequiredVisualReview(root, run, { artifactRoot: root }).verdict, 'confirm_ui');
      const wrongRevisionReview = validReview(run.runId, evidence);
      wrongRevisionReview.workspace_revision_sha256 = '1'.repeat(64);
      writeJson(reviewPath, wrongRevisionReview);
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /workspace_revision_sha256 must be/,
      );
      writeJson(reviewPath, validReview(run.runId, evidence));
      const approvedSourceSpec = readFileSync(visualBundle.specPath, 'utf8');
      const unapprovedSourceSpec = JSON.parse(approvedSourceSpec);
      unapprovedSourceSpec.approval = 'draft';
      writeJson(visualBundle.specPath, unapprovedSourceSpec);
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /source spec must remain approved/,
      );
      writeFileSync(visualBundle.specPath, approvedSourceSpec, 'utf8');
      const approvedExperience = readFileSync(visualBundle.experiencePath, 'utf8');
      writeFileSync(visualBundle.experiencePath, `${approvedExperience}\n`, 'utf8');
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /approved experience hash does not match the run contract/,
      );
      writeFileSync(visualBundle.experiencePath, approvedExperience, 'utf8');
      const approvedPrototype = readFileSync(visualBundle.prototypePath, 'utf8');
      writeFileSync(visualBundle.prototypePath, `${approvedPrototype}\n`, 'utf8');
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /prototype manifest hash does not match/,
      );
      writeFileSync(visualBundle.prototypePath, approvedPrototype, 'utf8');
      writeJson(
        path.join(root, `${run.runId}.visual-review.json`),
        validReview(run.runId, evidence, run.iterationId, {
          reviewedAt: '2099-01-01T00:01:00.000Z',
          capturedAt: '2099-01-01T00:00:00.000Z',
        }),
      );
      assert.throws(
        () => readRequiredVisualReview(root, run, {
          artifactRoot: root,
          finishedAt: '2026-08-01T02:00:00.000Z',
        }),
        /reviewed_at must not be later than the run finish/,
      );
      writeJson(path.join(root, `${run.runId}.visual-review.json`), validReview(run.runId, evidence));
      const accessibilityReport = JSON.parse(readFileSync(accessibilityPath, 'utf8'));
      accessibilityReport.scanned_at = '2000-01-01T00:00:00.000Z';
      writeJson(accessibilityPath, accessibilityReport);
      evidence.reportSha256 = sha256(accessibilityPath);
      writeJson(path.join(root, `${run.runId}.visual-review.json`), validReview(run.runId, evidence));
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /scanned_at must not predate the run start/,
      );
      accessibilityReport.scanned_at = '2026-08-01T00:59:00.000Z';
      writeJson(accessibilityPath, accessibilityReport);
      evidence.reportSha256 = sha256(accessibilityPath);
      const misplaced = validReview(run.runId, evidence);
      misplaced.results[0].artifact_ref = 'gate-b-spec/visual-design/VD-1/prototype.png';
      writeJson(path.join(root, `${run.runId}.visual-review.json`), misplaced);
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /must stay under visual-evidence\/iter-001\/run-task-001-001\//,
      );
      writeJson(path.join(root, `${run.runId}.visual-review.json`), validReview(run.runId, evidence));
      writeFileSync(screenshotPath, 'fixture', 'utf8');
      const forgedEvidence = { ...evidence, artifactSha256: sha256(screenshotPath) };
      writeJson(path.join(root, `${run.runId}.visual-review.json`), validReview(run.runId, forgedEvidence));
      assert.throws(
        () => readRequiredVisualReview(root, run, { artifactRoot: root }),
        /must be a valid PNG image/,
      );
      writePng(screenshotPath, 1440, 900);
      evidence.artifactSha256 = sha256(screenshotPath);
      const blocked = validReview(run.runId, evidence);
      blocked.results[0].status = 'failed';
      blocked.results[0].concerns = ['Primary action is below the fold'];
      blocked.accessibility.status = 'not_run';
      blocked.accessibility.report_ref = null;
      blocked.accessibility.report_sha256 = null;
      blocked.verdict = 'block';
      blocked.concerns = ['Primary action hierarchy drifted'];
      writeJson(path.join(root, `${run.runId}.visual-review.json`), blocked);
      assert.throws(() => readRequiredVisualReview(root, run, { artifactRoot: root }), /visual review blocked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
