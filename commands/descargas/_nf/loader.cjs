"use strict";
require("bytenode");
const path = require("node:path");
try {
  module.exports = require(path.join(__dirname, "core.jsc"));
} catch (e) {
  const m = String((e && e.message) || e);
  if (/version|incompatible|invalid bytecode/i.test(m)) {
    throw new Error(
      "[netflix] Incompatible con este node (" +
        process.version +
        "). Rebúuildea el plugin con la versión correcta o pide una nueva build."
    );
  }
  throw e;
}
