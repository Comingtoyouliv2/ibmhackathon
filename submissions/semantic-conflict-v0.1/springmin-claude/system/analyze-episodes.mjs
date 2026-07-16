import { readFile, writeFile, mkdir } from "node:fs/promises";
await mkdir("work/e2e", { recursive: true });

function changedLines(patch){
  const added=[], removed=[];
  for(const raw of (patch||"").split("\n")){
    if(raw.startsWith("+++")||raw.startsWith("---")||raw.startsWith("diff ")||raw.startsWith("index ")||raw.startsWith("@@")) continue;
    if(raw.startsWith("+")) added.push(raw.slice(1));
    else if(raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return [...added,...removed];
}
const METHOD_RE=/(?:public|private|protected|static|final|synchronized|abstract|native|\s)+[\w<>\[\],\s.?]+\s+(\w+)\s*\(/g;
const DEF_RE=/\b(?:class|interface|enum|void)\s+(\w+)/g;
const CALL_RE=/(\w+)\s*\(/g;
const NOISE=new Set(["if","for","while","switch","catch","return","new","super","this","assertEquals","assertTrue","assertThat","assertNotNull","assertFalse","toString","equals","hashCode","get","set","size","add","put"]);
function symbols(lines){
  const defs=new Set(), calls=new Set();
  for(const ln of lines){ let m;
    METHOD_RE.lastIndex=0; while((m=METHOD_RE.exec(ln))) defs.add(m[1]);
    DEF_RE.lastIndex=0; while((m=DEF_RE.exec(ln))) defs.add(m[1]);
    CALL_RE.lastIndex=0; while((m=CALL_RE.exec(ln))) calls.add(m[1]);
  }
  for(const n of NOISE){defs.delete(n);calls.delete(n);}
  return {defs,calls};
}
const moduleOf=(fn)=>{ const m=(fn||"").match(/modules\/(m-[0-9a-f]+)/); return m?m[1]:"(root)"; };
const inter=(a,b)=>[...a].filter(x=>b.has(x));
function excerpt(patch,max=380){
  const body=(patch||"").split("\n").filter(l=>(l.startsWith("+")||l.startsWith("-"))&&!l.startsWith("+++")&&!l.startsWith("---")).join("\n");
  return body.length>max? body.slice(0,max)+" …" : body;
}

const summary=[];
for(const epName of ["episode-01","episode-02"]){
  const ep=JSON.parse(await readFile(`semantic-conflict-end-to-end-v0.1/episodes/${epName}.json`,"utf8"));
  const prs=ep.prs.map(pr=>{
    const files=pr.files||[];
    const modules=new Set(files.map(f=>moduleOf(f.filename)));
    const fileSet=new Set(files.map(f=>f.filename));
    const allLines=files.flatMap(f=>changedLines(f.patch));
    const sym=symbols(allLines);
    return {id:pr.id, files, modules, fileSet, defs:sym.defs, calls:sym.calls, fileMap:new Map(files.map(f=>[f.filename,f]))};
  });
  // candidate pairs = share >=1 module (excluding root-only if it dominates)
  const cands=[];
  for(let i=0;i<prs.length;i++)for(let j=i+1;j<prs.length;j++){
    const A=prs[i],B=prs[j];
    const sharedMods=inter(A.modules,B.modules).filter(m=>m!=="(root)");
    if(sharedMods.length===0) continue;
    const sharedFiles=inter(A.fileSet,B.fileSet);
    const bothDefs=inter(A.defs,B.defs);
    const aDefBCall=inter(A.defs,B.calls);
    const bDefACall=inter(B.defs,A.calls);
    const score = sharedFiles.length*5 + bothDefs.length*4 + (aDefBCall.length+bDefACall.length)*2 + sharedMods.length;
    cands.push({A:A.id,B:B.id,i,j,score,sharedMods,sharedFiles,bothDefs,aDefBCall,bDefACall});
  }
  cands.sort((x,y)=>y.score-x.score);
  const TOP=28;
  const top=cands.slice(0,TOP);
  // dossier
  let d=`# EPISODE ${ep.episodeId}\ncandidate same-module pairs: ${cands.length} (metadata.candidatePairCount=${ep.metadata.candidatePairCount})\nShowing top ${top.length} by deterministic overlap score. Rank the 20 MOST LIKELY pair-induced semantic conflicts.\n\n`;
  let rank=0;
  for(const c of top){
    rank++;
    const A=prs[c.i],B=prs[c.j];
    d+=`\n## CAND ${rank}: ${c.A} x ${c.B}  (score ${c.score})\n`;
    d+=`shared modules: ${c.sharedMods.join(", ")}\n`;
    d+=`shared files: ${c.sharedFiles.length? c.sharedFiles.map(f=>f.split("/").pop()).join(", "):"(none — same module, different files)"}\n`;
    d+=`symbols changed by BOTH: ${JSON.stringify(c.bothDefs.slice(0,15))}\n`;
    d+=`A-defines&B-calls: ${JSON.stringify(c.aDefBCall.slice(0,15))} | B-defines&A-calls: ${JSON.stringify(c.bDefACall.slice(0,15))}\n`;
    if(c.sharedFiles.length){
      for(const fn of c.sharedFiles.slice(0,3)){
        d+=`--- ${fn.split("/").pop()} : A ---\n${excerpt(A.fileMap.get(fn).patch)}\n--- B ---\n${excerpt(B.fileMap.get(fn).patch)}\n`;
      }
    } else {
      // show one representative hunk per side
      d+=`A files: ${[...A.fileSet].map(f=>f.split("/").pop()).slice(0,4).join(", ")}\n`;
      d+=`  A hunk: ${excerpt(A.files[0]?.patch,240)}\n`;
      d+=`B files: ${[...B.fileSet].map(f=>f.split("/").pop()).slice(0,4).join(", ")}\n`;
      d+=`  B hunk: ${excerpt(B.files[0]?.patch,240)}\n`;
    }
  }
  await writeFile(`work/e2e/${epName}-candidates.md`, d);
  await writeFile(`work/e2e/${epName}-top.json`, JSON.stringify(top.map(c=>({A:c.A,B:c.B,score:c.score})),null,2));
  summary.push({ep:ep.episodeId, candidates:cands.length, metaCand:ep.metadata.candidatePairCount, top:top.length, topScores:top.slice(0,8).map(c=>`${c.A}x${c.B}:${c.score}`)});
}
console.log(JSON.stringify(summary,null,2));
