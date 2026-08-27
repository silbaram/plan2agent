'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');

const tracePath = process.env.P2A_FS_READ_TRACE;
const originalReadFileSync = fs.readFileSync;

if (tracePath) {
  fs.readFileSync = function tracedReadFileSync(file, ...args) {
    let resolved = null;
    if (typeof file === 'string') resolved = path.resolve(file);
    else if (file instanceof URL && file.protocol === 'file:') resolved = fileURLToPath(file);
    if (resolved && path.resolve(tracePath) !== path.resolve(resolved)) {
      fs.appendFileSync(tracePath, `${resolved}\n`, 'utf8');
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  syncBuiltinESMExports();
}
