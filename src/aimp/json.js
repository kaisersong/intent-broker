// Strict subset reused from KTeam src/protocol/json.ts; safe integers only.
class KTeamError extends Error {
  code;
  statusCode;
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.statusCode = status;
  }
}
function unicode(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const next = value.charCodeAt(++i);
      if (!(next >= 56320 && next <= 57343)) throw new KTeamError("invalid_unicode");
    } else if (c >= 56320 && c <= 57343) throw new KTeamError("invalid_unicode");
  }
}
function canonical(value, depth = 0) {
  if (depth > 32) throw new KTeamError("json_depth_exceeded");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    unicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + Array.from(value, (v) => canonical(v, depth + 1)).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((key) => {
      unicode(key);
      return JSON.stringify(key) + ":" + canonical(value[key], depth + 1);
    }).join(",") + "}";
  }
  throw new KTeamError("unsupported_json_value");
}
function parseAimpJson(input, maxBytes = 256 * 1024) {
  if (Buffer.byteLength(input) > maxBytes) throw new KTeamError("message_too_large", 413);
  let at = 0;
  function ws() {
    while (/[\x20\t\r\n]/.test(input[at] ?? "\0")) at++;
  }
  function string() {
    const start = at++;
    while (at < input.length) {
      const c = input[at++];
      if (c === "\\") {
        at++;
        continue;
      }
      if (c === '"') {
        const result = JSON.parse(input.slice(start, at));
        if (typeof result !== "string") throw new KTeamError("invalid_json");
        unicode(result);
        return result;
      }
    }
    throw new KTeamError("invalid_json");
  }
  function read(depth) {
    if (depth > 32) throw new KTeamError("json_depth_exceeded");
    ws();
    const c = input[at];
    if (c === '"') return string();
    if (c === "{") {
      at++;
      ws();
      const result2 = {};
      const keys = /* @__PURE__ */ new Set();
      if (input[at] === "}") {
        at++;
        return result2;
      }
      while (true) {
        ws();
        if (input[at] !== '"') throw new KTeamError("invalid_json");
        const key = string();
        if (keys.has(key)) throw new KTeamError("duplicate_json_key");
        keys.add(key);
        ws();
        if (input[at++] !== ":") throw new KTeamError("invalid_json");
        Object.defineProperty(result2, key, { value: read(depth + 1), enumerable: true, configurable: true });
        ws();
        const sep = input[at++];
        if (sep === "}") return result2;
        if (sep !== ",") throw new KTeamError("invalid_json");
      }
    }
    if (c === "[") {
      at++;
      ws();
      const result2 = [];
      if (input[at] === "]") {
        at++;
        return result2;
      }
      while (true) {
        result2.push(read(depth + 1));
        ws();
        const sep = input[at++];
        if (sep === "]") return result2;
        if (sep !== ",") throw new KTeamError("invalid_json");
      }
    }
    const match = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(at));
    if (!match) throw new KTeamError("invalid_json");
    at += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === "number" && !Number.isSafeInteger(result)) throw new KTeamError("unsupported_json_number");
    return result;
  }
  try {
    const result = read(0);
    ws();
    if (at !== input.length) throw new KTeamError("invalid_json");
    return result;
  } catch (error) {
    if (error instanceof KTeamError) throw error;
    throw new KTeamError("invalid_json");
  }
}
export {
  canonical,
  parseAimpJson
};
