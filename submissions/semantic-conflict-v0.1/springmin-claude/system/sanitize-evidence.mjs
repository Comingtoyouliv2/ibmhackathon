import { readFile, writeFile } from "node:fs/promises";
const inputs=(await readFile("semantic-conflict-pair-judgment-v0.1/inputs.jsonl","utf8")).split("\n").filter(Boolean).map(l=>JSON.parse(l));
function contains(v,q){ if(typeof v==="string")return v.includes(q); if(Array.isArray(v))return v.some(x=>contains(x,q)); if(v&&typeof v==="object")return Object.values(v).some(x=>contains(x,q)); return false;}
const EVREQ=new Set(["conflict","review","coordination"]);
const report=[];
for(let i=0;i<inputs.length;i++){
  const nn=String(i+1).padStart(2,"0");
  const p=`work/pair/pred-${nn}.json`;
  const o=JSON.parse(await readFile(p,"utf8"));
  const kept=[]; const dropped=[];
  for(const e of (o.evidence||[])){
    const pr=inputs[i].prs[e.side==="A"?0:1];
    if(e.quote && contains(pr,e.quote)) kept.push(e); else dropped.push(e);
  }
  if(dropped.length){
    if(EVREQ.has(o.prediction)){
      // must keep both sides; report for manual handling
      report.push(`${nn}: ${o.prediction} has ${dropped.length} non-verbatim evidence -> MANUAL`);
    } else {
      o.evidence=kept;
      await writeFile(p, JSON.stringify(o));
      report.push(`${nn}: ${o.prediction} dropped ${dropped.length} non-verbatim evidence (ok)`);
    }
  }
}
console.log(report.length?report.join("\n"):"nothing to sanitize");
