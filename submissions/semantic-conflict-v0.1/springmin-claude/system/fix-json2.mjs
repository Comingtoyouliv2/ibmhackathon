import { readFile, writeFile } from "node:fs/promises";
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
function repair(raw){
  let out=""; let inStr=false; let esc=false;
  for(const ch of raw){
    if(esc){ out+=ch; esc=false; continue; }
    if(ch===BACKSLASH){ out+=ch; esc=true; continue; }
    if(ch===QUOTE){ inStr=!inStr; out+=ch; continue; }
    if(inStr){
      const code=ch.charCodeAt(0);
      if(code<0x20){
        if(ch==="\t") out+=BACKSLASH+"t";
        else if(ch==="\n") out+=BACKSLASH+"n";
        else if(ch==="\r") out+=BACKSLASH+"r";
        else out+=BACKSLASH+"u"+code.toString(16).padStart(4,"0");
        continue;
      }
    }
    out+=ch;
  }
  return out;
}
for(const nn of ["02","21","22","34"]){
  const p=`work/pair/pred-${nn}.json`;
  const raw=await readFile(p,"utf8");
  const obj=JSON.parse(repair(raw));
  await writeFile(p, JSON.stringify(obj));
  console.log(`${nn}: repaired OK -> prediction=${obj.prediction}`);
}
