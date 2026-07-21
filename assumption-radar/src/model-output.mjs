export function repairJsonControlChars(raw) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (escaped) { output += character; escaped = false; continue; }
    if (character === "\\") { output += character; escaped = true; continue; }
    if (character === '"') { inString = !inString; output += character; continue; }
    if (inString && character.charCodeAt(0) < 0x20) {
      if (character === "\t") output += "\\t";
      else if (character === "\n") output += "\\n";
      else if (character === "\r") output += "\\r";
      else output += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return output;
}

function parseCandidate(body) {
  try { return JSON.parse(body); }
  catch { return JSON.parse(repairJsonControlChars(body)); }
}

/**
 * Parses the first complete JSON object from model output. This tolerates
 * Markdown fences and trailing usage/statistics objects without accidentally
 * joining them into one invalid JSON document.
 */
export function extractFirstJsonObject(text) {
  const source = String(text || "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (escaped) { escaped = false; continue; }
      if (character === "\\" && inString) { escaped = true; continue; }
      if (character === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth !== 0) continue;
      const candidate = source.slice(start, cursor + 1);
      try { return parseCandidate(candidate); }
      catch { break; }
    }
  }
  throw new Error("모델 응답에 유효한 JSON object가 없습니다.");
}
