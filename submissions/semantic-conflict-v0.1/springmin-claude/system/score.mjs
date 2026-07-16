// 채점 스크립트 (gold가 있으면 실제 정확도, 없으면 예측 분포만)
// 사용법:
//   node work/score.mjs                              -> gold 없이 예측 분포
//   node work/score.mjs work/gold-pair.jsonl work/gold-e2e.jsonl  -> 실제 채점
import { readFile } from "node:fs/promises";

const [goldPairPath, goldE2ePath] = process.argv.slice(2);
const LABELS = ["conflict","review","independent","insufficient","coordination"];

async function readJsonl(p){ return (await readFile(p,"utf8")).split("\n").map(l=>l.trim()).filter(Boolean).map(l=>JSON.parse(l)); }
function pct(x){ return (x*100).toFixed(1)+"%"; }

// ---------- TEST 1 ----------
const preds1 = await readJsonl("submission/pair-qualification-predictions.jsonl");
console.log("========== TEST 1 · Pair Judgment ==========");
const dist1 = {}; preds1.forEach(p=>dist1[p.prediction]=(dist1[p.prediction]||0)+1);
console.log("예측 분포:", JSON.stringify(dist1));

if (goldPairPath){
  // gold-pair.jsonl : {"id": "...", "label": "conflict|review|independent|insufficient|coordination"}
  const gold = new Map((await readJsonl(goldPairPath)).map(g=>[g.id, g.label]));
  let correct=0, total=0;
  const cm = {}; // confusion[gold][pred]
  const perClass = {}; LABELS.forEach(l=>perClass[l]={tp:0,fp:0,fn:0});
  // binary: conflict vs not-conflict
  let bTP=0,bFP=0,bFN=0,bTN=0;
  for(const p of preds1){
    const g = gold.get(p.id); if(g===undefined) continue;
    total++; if(p.prediction===g) correct++;
    cm[g]=cm[g]||{}; cm[g][p.prediction]=(cm[g][p.prediction]||0)+1;
    for(const l of LABELS){
      if(p.prediction===l && g===l) perClass[l].tp++;
      else if(p.prediction===l && g!==l) perClass[l].fp++;
      else if(p.prediction!==l && g===l) perClass[l].fn++;
    }
    const pC = p.prediction==="conflict", gC = g==="conflict";
    if(pC&&gC)bTP++; else if(pC&&!gC)bFP++; else if(!pC&&gC)bFN++; else bTN++;
  }
  console.log(`\n전체 정확도(accuracy): ${correct}/${total} = ${pct(correct/total)}`);
  console.log("\n클래스별 정밀도/재현율/F1:");
  for(const l of LABELS){
    const {tp,fp,fn}=perClass[l];
    const prec = tp+fp? tp/(tp+fp):0, rec = tp+fn? tp/(tp+fn):0, f1 = prec+rec? 2*prec*rec/(prec+rec):0;
    console.log(`  ${l.padEnd(13)} P=${pct(prec)}  R=${pct(rec)}  F1=${pct(f1)}  (tp${tp} fp${fp} fn${fn})`);
  }
  const bP=bTP+bFP?bTP/(bTP+bFP):0, bR=bTP+bFN?bTP/(bTP+bFN):0, bF=bP+bR?2*bP*bR/(bP+bR):0;
  const bAcc=(bTP+bTN)/(bTP+bTN+bFP+bFN);
  console.log(`\n[이진] conflict vs not-conflict: accuracy=${pct(bAcc)}  P=${pct(bP)}  R=${pct(bR)}  F1=${pct(bF)}`);
  console.log("혼동행렬(gold→pred):", JSON.stringify(cm,null,0));
} else {
  console.log("(gold 없음 → 실제 정확도 계산 불가. gold-pair.jsonl 넣으면 클래스별 P/R/F1 + conflict/not-conflict 정확도 출력)");
}

// ---------- TEST 2 ----------
console.log("\n========== TEST 2 · End-to-End Radar ==========");
const preds2 = await readJsonl("submission/radar-arena-predictions.jsonl");
const byEp = {}; preds2.forEach(p=>{ (byEp[p.episodeId]=byEp[p.episodeId]||[]).push(p); });
for(const ep of Object.keys(byEp)){
  const dist={}; byEp[ep].forEach(p=>dist[p.decision]=(dist[p.decision]||0)+1);
  console.log(`${ep}: decision 분포 ${JSON.stringify(dist)}`);
}
if (goldE2ePath){
  // gold-e2e.jsonl : {"episodeId":"...","conflictPairs":[["PR-001","PR-002"], ...]}
  const key=(a,b)=>[a,b].sort().join(":");
  const gmap = new Map((await readJsonl(goldE2ePath)).map(g=>[g.episodeId, new Set(g.conflictPairs.map(p=>key(p[0],p[1])))]));
  for(const ep of Object.keys(byEp)){
    const gold = gmap.get(ep); if(!gold) continue;
    const ranked = byEp[ep].sort((a,b)=>a.rank-b.rank).map(p=>key(p.prA,p.prB));
    const G = gold.size;
    for(const k of [5,10,20]){
      const hit = ranked.slice(0,k).filter(x=>gold.has(x)).length;
      console.log(`  ${ep} P@${k}=${pct(hit/k)}  R@${k}=${pct(G?hit/G:0)}  (${hit} hits)`);
    }
  }
} else {
  console.log("(gold 없음 → 순위 정확도 계산 불가. gold-e2e.jsonl 넣으면 P@5/P@10/P@20, Recall@20 출력)");
}