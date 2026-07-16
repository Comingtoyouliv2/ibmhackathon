import { readFile, writeFile, stat } from "node:fs/promises";
const INPUTS = "semantic-conflict-pair-judgment-v0.1/inputs.jsonl";
const inputs = (await readFile(INPUTS,"utf8")).split("\n").map(l=>l.trim()).filter(Boolean).map(l=>JSON.parse(l));
const out=[]; const problems=[]; let minM=Infinity, maxM=0;
function extractJson(t){ const s=t.indexOf("{"); const e=t.lastIndexOf("}"); if(s<0||e<0) throw new Error("no JSON braces"); return JSON.parse(t.slice(s,e+1)); }
for(let i=0;i<inputs.length;i++){
  const nn=String(i+1).padStart(2,"0");
  const p=`work/pair/pred-${nn}.json`;
  let rec;
  try{ const raw=await readFile(p,"utf8"); rec=extractJson(raw); const st=await stat(p); minM=Math.min(minM,st.mtimeMs); maxM=Math.max(maxM,st.mtimeMs);}catch(e){ problems.push(`${nn}: ${e.message}`); continue; }
  if(rec.id!==inputs[i].id) problems.push(`${nn}: id mismatch pred='${rec.id}' expected='${inputs[i].id}'`);
  out.push(rec);
}
await writeFile("submission/pair-qualification-predictions.jsonl", out.map(r=>JSON.stringify(r)).join("\n")+"\n");
console.log("assembled:", out.length, "/", inputs.length);
console.log("wallclock ms (pred mtime span):", Math.round(maxM-minM));
console.log("label distribution:");
const dist={}; out.forEach(r=>dist[r.prediction]=(dist[r.prediction]||0)+1);
console.log(JSON.stringify(dist,null,0));
if(problems.length){ console.log("PROBLEMS:"); problems.forEach(p=>console.log("  "+p)); } else console.log("no problems");
// stash timing
await writeFile("work/pair-timing.json", JSON.stringify({wallclockMs:Math.round(maxM-minM), startMs:minM, endMs:maxM}));
