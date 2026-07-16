import { readFile, writeFile, mkdir } from "node:fs/promises";

const ROOT = "semantic-conflict-pair-judgment-v0.1/inputs.jsonl";
const OUT = "work/pair";
await mkdir(OUT, { recursive: true });

const text = await readFile(ROOT, "utf8");
const cases = text.split("\n").map(l=>l.trim()).filter(Boolean).map(l=>JSON.parse(l));

// --- helpers ---
function changedLines(patch){
  // returns {added:[], removed:[]} of code lines (without +/- marker), skipping hunk headers
  const added=[], removed=[];
  for(const raw of (patch||"").split("\n")){
    if(raw.startsWith("+++")||raw.startsWith("---")||raw.startsWith("diff ")||raw.startsWith("index ")||raw.startsWith("@@")) continue;
    if(raw.startsWith("+")) added.push(raw.slice(1));
    else if(raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return {added, removed};
}
const METHOD_RE = /(?:public|private|protected|static|final|synchronized|abstract|native|\s)+[\w<>\[\],\s\.?]+\s+(\w+)\s*\(/g;
const DEF_RE = /\b(?:class|interface|enum|void|def|function)\s+(\w+)/g;
const CALL_RE = /(\w+)\s*\(/g;
function symbolsFrom(lines){
  const defs=new Set(), calls=new Set();
  for(const ln of lines){
    let m;
    METHOD_RE.lastIndex=0; while((m=METHOD_RE.exec(ln))) defs.add(m[1]);
    DEF_RE.lastIndex=0; while((m=DEF_RE.exec(ln))) defs.add(m[1]);
    CALL_RE.lastIndex=0; while((m=CALL_RE.exec(ln))) calls.add(m[1]);
  }
  const noise=new Set(["if","for","while","switch","catch","return","new","super","this","assertEquals","assertTrue","assertThat","assertNotNull","assertFalse"]);
  for(const n of noise){defs.delete(n);calls.delete(n);}
  return {defs, calls};
}
function fileMap(pr){
  const m=new Map();
  for(const f of pr.files||[]) m.set(f.filename, f);
  return m;
}
function excerpt(patch, max=1400){
  const body=(patch||"").split("\n").filter(l=>l.startsWith("+")||l.startsWith("-")).filter(l=>!l.startsWith("+++")&&!l.startsWith("---")).join("\n");
  return body.length>max? body.slice(0,max)+"\n… [truncated]" : body;
}

const index=[];
let i=0;
for(const c of cases){
  i++;
  const A=c.prs[0], B=c.prs[1];
  const fa=fileMap(A), fb=fileMap(B);
  const shared=[...fa.keys()].filter(k=>fb.has(k));
  // symbols per side (across all files)
  const aAll={defs:new Set(),calls:new Set()}, bAll={defs:new Set(),calls:new Set()};
  for(const f of A.files||[]){ const {added,removed}=changedLines(f.patch); const s=symbolsFrom([...added,...removed]); s.defs.forEach(x=>aAll.defs.add(x)); s.calls.forEach(x=>aAll.calls.add(x)); }
  for(const f of B.files||[]){ const {added,removed}=changedLines(f.patch); const s=symbolsFrom([...added,...removed]); s.defs.forEach(x=>bAll.defs.add(x)); s.calls.forEach(x=>bAll.calls.add(x)); }
  // cross signals: A defines & B calls (and vice versa)
  const aDefBCall=[...aAll.defs].filter(x=>bAll.calls.has(x));
  const bDefACall=[...bAll.defs].filter(x=>aAll.calls.has(x));
  // symbols changed on BOTH sides (potential same-contract edits)
  const bothDefs=[...aAll.defs].filter(x=>bAll.defs.has(x));

  const paddedNum=String(i).padStart(2,"0");
  index.push({n:paddedNum, id:c.id, shared:shared.length, aFiles:(A.files||[]).length, bFiles:(B.files||[]).length,
              aDefBCall:aDefBCall.length, bDefACall:bDefACall.length, bothDefs:bothDefs.length});

  // dossier
  let d=`# CASE ${paddedNum}\nid: ${c.id}\n\n`;
  d+=`A (prs[0]) #${A.number} files:${(A.files||[]).length}\nB (prs[1]) #${B.number} files:${(B.files||[]).length}\n\n`;
  d+=`## Deterministic signals\n`;
  d+=`- shared files (both modified): ${shared.length}\n`;
  d+=`- symbols A-defines & B-calls: ${JSON.stringify(aDefBCall.slice(0,25))}\n`;
  d+=`- symbols B-defines & A-calls: ${JSON.stringify(bDefACall.slice(0,25))}\n`;
  d+=`- symbols changed by BOTH: ${JSON.stringify(bothDefs.slice(0,25))}\n\n`;
  if(shared.length){
    d+=`## Shared files — hunks from BOTH sides\n`;
    for(const fn of shared.slice(0,12)){
      d+=`\n### FILE: ${fn}\n--- A hunks ---\n\`\`\`\n${excerpt(fa.get(fn).patch)}\n\`\`\`\n--- B hunks ---\n\`\`\`\n${excerpt(fb.get(fn).patch)}\n\`\`\`\n`;
    }
    if(shared.length>12) d+=`\n… (+${shared.length-12} more shared files)\n`;
  } else {
    d+=`## No shared files. Cross-symbol candidate regions:\n`;
    // show A files that define aDefBCall symbols and B files that call them
    const showSym=[...new Set([...aDefBCall,...bDefACall])].slice(0,8);
    if(showSym.length===0){ d+=`(no cross-file symbol overlap detected — likely disjoint)\n`; }
    else {
      for(const sym of showSym){
        d+=`\n### symbol: ${sym}\n`;
        for(const f of A.files||[]){ if((f.patch||"").includes(sym)){ d+=`-- A file ${f.filename} --\n\`\`\`\n${excerpt(f.patch,700)}\n\`\`\`\n`; break; } }
        for(const f of B.files||[]){ if((f.patch||"").includes(sym)){ d+=`-- B file ${f.filename} --\n\`\`\`\n${excerpt(f.patch,700)}\n\`\`\`\n`; break; } }
      }
    }
    d+=`\n## File lists\nA: ${(A.files||[]).map(f=>f.filename).slice(0,40).join(", ")}\nB: ${(B.files||[]).map(f=>f.filename).slice(0,40).join(", ")}\n`;
  }
  await writeFile(`${OUT}/case-${paddedNum}.md`, d);
}
await writeFile(`${OUT}/_index.json`, JSON.stringify(index,null,2));
console.log("dossiers written:", i);
console.log("\nn  | shared aF  bF  A→B B→A both | id");
for(const r of index) console.log(`${r.n} | ${String(r.shared).padStart(6)} ${String(r.aFiles).padStart(3)} ${String(r.bFiles).padStart(3)} ${String(r.aDefBCall).padStart(3)} ${String(r.bDefACall).padStart(3)} ${String(r.bothDefs).padStart(4)} | ${r.id.slice(0,45)}`);
