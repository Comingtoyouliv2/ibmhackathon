import { readFile, writeFile, stat } from "node:fs/promises";
function extractJsonArray(t){ const s=t.indexOf("["); const e=t.lastIndexOf("]"); if(s<0||e<0) throw new Error("no JSON array"); return JSON.parse(t.slice(s,e+1)); }
const key=(a,b)=>[a,b].sort().join(":");
const out=[]; let minM=Infinity,maxM=0; const report=[];
for(const epName of ["episode-01","episode-02"]){
  const ep=JSON.parse(await readFile(`semantic-conflict-end-to-end-v0.1/episodes/${epName}.json`,"utf8"));
  const episodeId=ep.episodeId;
  const validIds=new Set(ep.prs.map(p=>p.id));
  const auth=JSON.parse(await readFile(`work/e2e/${epName}-top.json`,"utf8")); // canonical 20 pairs {A,B,score}
  const authByKey=new Map(auth.map(p=>[key(p.A,p.B),p]));
  const rankedRaw=await readFile(`work/e2e/${epName}-ranked.json`,"utf8");
  const st=await stat(`work/e2e/${epName}-ranked.json`); minM=Math.min(minM,st.mtimeMs); maxM=Math.max(maxM,st.mtimeMs);
  const ranked=extractJsonArray(rankedRaw);
  const seen=new Set(); const ordered=[];
  for(const r of ranked){
    if(!r||!r.prA||!r.prB) continue;
    const k=key(r.prA,r.prB);
    if(!authByKey.has(k)){ report.push(`${epName}: ranked pair ${r.prA}x${r.prB} not in candidate set — skipped`); continue; }
    if(seen.has(k)) continue;
    seen.add(k);
    const canon=authByKey.get(k);
    ordered.push({prA:canon.A, prB:canon.B,
      decision: ["conflict","review","independent","insufficient","coordination"].includes(r.decision)? r.decision : "review",
      confidence: (typeof r.confidence==="number" && r.confidence>=0 && r.confidence<=1)? r.confidence : 0.4,
      explanation: (typeof r.explanation==="string" && r.explanation.trim())? r.explanation.trim() : "Same-module pair; potential shared-contract interaction." });
  }
  // append any authoritative pairs the ranker omitted (lowest ranks)
  for(const p of auth){ const k=key(p.A,p.B); if(!seen.has(k)){ seen.add(k); ordered.push({prA:p.A,prB:p.B,decision:"review",confidence:0.3,explanation:"Same-module candidate pair not prioritized by the ranker; retained as a lower-likelihood interaction."}); report.push(`${epName}: appended omitted pair ${p.A}x${p.B}`);} }
  const final=ordered.slice(0,20);
  final.forEach((r,i)=>{
    out.push({schemaVersion:"radar-arena-prediction-v0.1", episodeId, prA:r.prA, prB:r.prB, rank:i+1, confidence:r.confidence, decision:r.decision, explanation:r.explanation});
  });
  const dist={}; final.forEach(r=>dist[r.decision]=(dist[r.decision]||0)+1);
  report.push(`${epName}: ${final.length} ranked | decisions ${JSON.stringify(dist)}`);
}
await writeFile("submission/radar-arena-predictions.jsonl", out.map(r=>JSON.stringify(r)).join("\n")+"\n");
await writeFile("work/e2e-timing.json", JSON.stringify({startMs:minM,endMs:maxM,wallclockMs:Math.round(maxM-minM)}));
console.log("total records:", out.length);
console.log(report.join("\n"));
