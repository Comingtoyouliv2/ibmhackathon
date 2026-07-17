const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { runId: 'openclaw-current', run: null, summary: null, pairs: [], graph: null, selected: null, view: 'queue', mapMode: 'resources', filter: 'all', search: '', poll: null };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = (value) => Number(value ?? 0).toLocaleString();
const pairId = (pair) => `${pair.prA}:${pair.prB}`;
const judgmentKey = () => `pr-radar-judgments:${state.runId}`;
let graphController = null;

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2200);
}
async function api(url, options) {
  const response = await fetch(url, { headers: {'Content-Type':'application/json'}, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function judgments() {
  try { return JSON.parse(localStorage.getItem(judgmentKey()) || '{}'); } catch { return {}; }
}
function saveJudgment(id, value) {
  const current = judgments(); current[id] = value; localStorage.setItem(judgmentKey(), JSON.stringify(current));
}
const VERDICTS = {
  conflict: { label:'Confirmed conflict', color:'#d6453a', dash:[] },
  uncertain: { label:'Uncertain', color:'#dc9b00', dash:[7,4] },
  unreviewed: { label:'Unreviewed / uncertain', color:'#dc9b00', dash:[2,5] },
  possible_duplicate: { label:'Possible duplicate', color:'#7a4fd6', dash:[] },
  harmless: { label:'Harmless', color:'#8e9aa4', dash:[] },
};
function pairVerdict(pair) {
  const saved = judgments()[pairId(pair)];
  if (saved === 'no_conflict') return 'harmless';
  return VERDICTS[saved] ? saved : 'unreviewed';
}
function assessmentType(pair) {
  if (pair.relation === 'explicit_dependency') return 'Stack / dependency ordering';
  const resources = pair.sharedResources || [];
  if (resources.some((value) => /^(schema|api|symbol):/.test(value))) return 'Contract compatibility';
  if (resources.some((value) => /^state:/.test(value))) return 'State lifecycle';
  if (resources.some((value) => /^config:/.test(value))) return 'Configuration semantics';
  if (resources.some((value) => /^event:/.test(value))) return 'Event producer / consumer';
  if (resources.some((value) => /^file:/.test(value))) return 'Implementation overlap';
  return 'Context-only candidate';
}
function graphPr(number) {
  return [...(state.graph?.prs || []), ...(state.graph?.externalPrs || [])].find((pr) => pr.pr === number);
}
function relationCardHtml(pair, perspectivePr = null) {
  const verdict = pairVerdict(pair); const meta = VERDICTS[verdict];
  const other = perspectivePr === pair.prA ? pair.prB : perspectivePr === pair.prB ? pair.prA : null;
  const otherTitle = perspectivePr === pair.prA ? pair.titleB : perspectivePr === pair.prB ? pair.titleA : '';
  const hypothesis = pair.potentialConflicts?.[0] || 'The retrieval signals overlap, but the semantic effect still requires review.';
  return `<button class="assessment-card" data-map-pair="${pairId(pair)}" style="--pair-color:${meta.color}">
    <span class="assessment-rail"></span><span class="assessment-main">
      <span class="assessment-top"><b>${other ? `#${other} · ${esc(otherTitle)}` : `#${pair.prA} × #${pair.prB}`}</b><em>${esc(meta.label)}</em></span>
      <span class="assessment-kind">${esc(assessmentType(pair))} · score ${pair.score.toFixed(2)}</span>
      <span class="assessment-hypothesis">${esc(hypothesis)}</span>
      <span class="assessment-resources">${(pair.sharedResources || []).slice(0, 3).map(esc).join(' · ') || 'Explicit relationship; no shared concrete resource'}</span>
    </span><span class="assessment-open">Open →</span>
  </button>`;
}

function renderFunnel() {
  const s = state.summary || {};
  const steps = [
    [fmt(s.openPrs), 'open PRs'], [fmt(s.pass), 'Step 0 pass'], [fmt(s.deferred), 'main-conflict deferred'],
    [fmt(s.theoreticalPairs), 'possible pairs'], [fmt(s.retrievalCandidates), 'retrieval candidates'], [fmt(s.queue), 'review queue'],
  ];
  $('#funnel').innerHTML = steps.map(([number,label], index) => `<div class="fstep ${index === 5 ? 'accent' : ''}"><strong>${number}</strong><span>${label}</span></div>`).join('');
  $('#queue-count').textContent = s.queue ?? 0;
}
function status(run) {
  state.run = run;
  const running = run?.status === 'running' || run?.status === 'queued';
  const failed = run?.status === 'failed' || run?.status === 'cancelled';
  $('#status-dot').className = `dot ${running ? 'running' : failed ? 'failed' : 'ready'}`;
  $('#run-status').textContent = run ? `${run.stage}${running ? ` · ${run.progress}%` : ''}` : 'Ready';
  $('#scan-button').disabled = running;
  $('#progress-card').classList.toggle('hidden', !running && !failed);
  if (run) {
    $('#progress-stage').textContent = run.stage;
    $('#progress-pct').textContent = `${run.progress ?? 0}%`;
    $('#progress-bar').style.width = `${run.progress ?? 0}%`;
    $('#run-log').textContent = (run.logs || []).slice(-70).join('\n') || 'Preparing the analysis process…';
    $('#run-log').scrollTop = $('#run-log').scrollHeight;
  }
}
function filteredPairs() {
  const js = judgments();
  return state.pairs.filter((pair) => {
    if (state.filter === 'independent' && pair.relation !== 'independent') return false;
    if (state.filter === 'dependency' && pair.relation !== 'explicit_dependency') return false;
    if (state.filter === 'unreviewed' && js[pairId(pair)]) return false;
    if (!state.search) return true;
    const hay = `${pair.prA} ${pair.prB} ${pair.titleA} ${pair.titleB} ${pair.sharedSectors.join(' ')} ${pair.sharedDomains.join(' ')} ${pair.sharedSubDomains.join(' ')} ${pair.sharedResources.join(' ')}`.toLowerCase();
    return hay.includes(state.search.toLowerCase());
  });
}
function contractBadge(pair) {
  const strong = pair.sharedResources.some((r) => /^(schema|api|state|config|event|symbol):/.test(r));
  return strong ? '<span class="badge contract">CONTRACT CONTACT</span>' : '';
}
function renderQueue() {
  const pairs = filteredPairs(); const js = judgments();
  $('#queue-view').innerHTML = `
    <div class="summary-note"><span><b>${fmt(pairs.length)} candidates</b> · A candidate is a PR pair with evidence worth checking, not a confirmed conflict.</span><span><b>${state.summary?.reductionPct ?? 0}% reduction</b> from all possible pairs</span></div>
    ${pairs.length ? pairs.map((pair) => {
      const id = pairId(pair); const judged = js[id];
      const risk = Math.max(8, Math.min(100, 24 + Math.log10(Math.max(1, pair.score)) * 27));
      return `<article class="queue-row ${state.selected === id ? 'selected' : ''}" style="--risk:${risk}%" data-pair="${id}" tabindex="0">
        <div class="row-top"><span class="pair-number">#${pair.prA} × #${pair.prB}</span>
          ${pair.relation === 'explicit_dependency' ? '<span class="badge dep">DEPENDENCY</span>' : ''}${contractBadge(pair)}
          ${judged ? `<span class="badge reviewed">${esc((VERDICTS[judged === 'no_conflict' ? 'harmless' : judged]?.label || judged).toUpperCase())}</span>` : ''}<span class="score">score ${pair.score.toFixed(2)}</span></div>
        <div class="titles">${esc(pair.titleA)} <span class="vs">VS</span> ${esc(pair.titleB)}</div>
        <div class="row-meta"><span>${esc(pair.selectionStage)}</span><span>·</span><span>${pair.sharedSectors.map(esc).join(', ') || 'dependency-only'}</span></div>
        <div class="row-meta resource-preview">${pair.sharedResources.slice(0,4).map(esc).join(' · ') || 'Explicit PR relationship'}</div>
      </article>`;
    }).join('') : '<div class="empty-list"><b>No candidates match these conditions.</b>Try a different search term or filter.</div>'}`;
}
function barChart(title, rows) {
  const max = Math.max(1, ...(rows || []).map((row) => row.count));
  return `<section class="chart"><h2>${esc(title)}</h2>${(rows || []).map((row) => `<div class="bar-row" title="${esc(row.name)}"><span class="bar-label">${esc(row.name)}</span><span class="bar-track"><i style="width:${100*row.count/max}%"></i></span><span class="bar-value">${fmt(row.count)}</span></div>`).join('')}</section>`;
}
function renderMap() {
  graphController?.destroy();
  const resourceMode = state.mapMode === 'resources';
  const relationMode = state.mapMode === 'relations';
  const hotResources = (state.graph?.resources || []).map((resource)=>({...resource,pairCount:state.pairs.filter((pair)=>pair.sharedResources.includes(resource.key)).length})).filter((resource) => resource.count > 1&&resource.pairCount>0).sort((a,b)=>b.pairCount-a.pairCount||b.count-a.count).slice(0, 12);
  $('#map-view').innerHTML = `<div class="summary-note"><span><b>${resourceMode ? 'Resource-centric PR graph' : relationMode ? 'PR relation map' : 'Classification hierarchy'}</b> · ${resourceMode ? 'Shared files and symbols are hubs; their touched PRs branch out. Colored PR-to-PR edges are review candidates, not automatic conflict verdicts.' : relationMode ? 'Every Step 0 pass PR is grouped by sector. Colored lines are review-queue relations, not automatically confirmed conflicts.' : 'A clean sector → domain → sub-domain → PR stack, with pair edges intentionally hidden.'}</span><span>${fmt(state.graph?.prs?.length || 0)} PRs · select · pan · zoom</span></div>
    <section class="network-card">
      <div class="network-head"><div><span class="network-kicker">RELATIONSHIP WORKBENCH</span><h2>${resourceMode ? 'Shared resource hubs → touched PR branches → PR review links' : relationMode ? 'All PRs, sector lanes, and semantic review candidates' : 'Sector → domain → sub-domain → PR'}</h2></div>
        <div class="network-actions map-switch"><button class="graph-button ${resourceMode ? 'active' : ''}" data-map-mode="resources">Resource graph</button><button class="graph-button ${relationMode ? 'active' : ''}" data-map-mode="relations">PR lanes</button><button class="graph-button ${!resourceMode && !relationMode ? 'active' : ''}" data-map-mode="hierarchy">Hierarchy stack</button><button class="graph-button" data-graph-action="fit">Fit all</button>${!resourceMode && !relationMode ? '<button class="graph-button active" data-graph-action="physics" aria-pressed="true">Pause layout</button>' : ''}</div></div>
      <div class="network-legend graph-verdict-legend">${resourceMode ? '<span><i class="square-key"></i> shared file / symbol</span><span><i class="circle-key"></i> touched PR</span><span><i class="edge-key resource-edge"></i> touched-resource branch</span><span><i class="edge-key conflict-edge"></i> confirmed conflict</span><span><i class="edge-key uncertain-edge"></i> uncertain / unreviewed</span><span><i class="edge-key duplicate-edge"></i> possible duplicate</span><span><i class="edge-key harmless-edge"></i> harmless</span><span><i class="edge-key stack-edge"></i> stack/dependency</span>' : relationMode ? '<span><i class="circle-key"></i> Step 0 pass PR</span><span><i class="edge-key conflict-edge"></i> confirmed conflict</span><span><i class="edge-key uncertain-edge"></i> uncertain / unreviewed</span><span><i class="edge-key duplicate-edge"></i> possible duplicate</span><span><i class="edge-key harmless-edge"></i> harmless</span><span><i class="edge-key stack-edge"></i> stack/dependency</span>' : '<span><i class="sector-key"></i> sector</span><span><i class="domain-key"></i> domain</span><span><i class="subdomain-key"></i> sub-domain</span><span><i class="circle-key"></i> PR</span><span class="legend-note">Pair and resource edges are hidden in this mode.</span>'}</div>
      <div class="network-layout">
        <div class="graph-stage">${!resourceMode && !relationMode ? '<div class="graph-axis hierarchy-axis"><span>SECTOR</span><span>DOMAIN</span><span>SUB-DOMAIN</span><span>PR</span></div>' : ''}<canvas id="resource-graph" tabindex="0" aria-label="${resourceMode ? 'Shared resource centered pull request graph' : relationMode ? 'Pull request relation graph grouped by sector' : 'Sector, domain, sub-domain, and pull request hierarchy graph'}"></canvas><div id="graph-tooltip" class="graph-tooltip hidden"></div><div class="graph-hint">Click a PR or resource to focus · click a colored PR link to open its faceoff · drag a node to arrange · scroll to zoom</div></div>
        <div class="map-lower"><div id="graph-inspector" class="graph-inspector assessment-inspector"><span class="network-kicker">SEMANTIC ASSESSMENT STACK</span><h3>Select a PR</h3><p>Its review candidates will appear here with type, evidence, hypothesis, and current verdict.</p></div><section class="hot-resources"><span class="network-kicker">HOT RESOURCES</span><h3>Shared resources with review-queue pairs</h3><div class="hot-resource-list">${hotResources.map((resource) => `<button data-hot-resource="${esc(resource.key)}"><span>${esc(resource.key)}</span><b>${fmt(resource.count)} PRs</b><em>${fmt(resource.pairCount)} queue pairs</em></button>`).join('') || '<p>No shared resources have review-queue pairs in this run.</p>'}</div></section></div>
      </div>
    </section><div class="chart-grid">${barChart('Largest sectors', state.summary?.sectors)}${barChart('Largest responsibility buckets', state.summary?.domains)}</div>`;
  requestAnimationFrame(() => { graphController = resourceMode ? drawResourceGraph() : relationMode ? drawRelationGraph() : drawGraph(); });
}
function drawResourceGraph() {
  const canvas = $('#resource-graph'); if (!canvas) return null;
  const inspector = $('#graph-inspector'); const tooltip = $('#graph-tooltip'); const card = canvas.closest('.network-card');
  const allPrs = [...(state.graph?.prs || []), ...(state.graph?.externalPrs || []).map((pr) => ({...pr, external:true, hierarchy:[], resources:[]}))];
  const resourceMeta = new Map((state.graph?.resources || []).map((resource) => [resource.key,resource]));
  const queueCount = new Map(); state.pairs.forEach((pair) => pair.sharedResources.forEach((key) => queueCount.set(key,(queueCount.get(key)||0)+1)));
  const resources = [...queueCount.keys()].map((key) => ({key,count:resourceMeta.get(key)?.count || 0,pairCount:queueCount.get(key)||0,members:[]})).filter((resource) => resource.count > 1).sort((a,b)=>b.pairCount-a.pairCount||b.count-a.count||a.key.localeCompare(b.key)).slice(0,18);
  const byResource = new Map(resources.map((resource) => [resource.key,{...resource,id:`resource:${resource.key}`,x:0,y:0,size:0,type:'resource'}]));
  const resourceSet = new Set(byResource.keys());
  const wanted = new Set();
  allPrs.forEach((pr) => { if ((pr.resources || []).some((key)=>resourceSet.has(key))) wanted.add(pr.pr); });
  state.pairs.forEach((pair) => { if (pair.sharedResources.some((key)=>resourceSet.has(key))) { wanted.add(pair.prA); wanted.add(pair.prB); } });
  const pairDegree = new Map(); state.pairs.forEach((pair)=>{pairDegree.set(pair.prA,(pairDegree.get(pair.prA)||0)+1);pairDegree.set(pair.prB,(pairDegree.get(pair.prB)||0)+1);});
  const nodes = allPrs.filter((pr)=>wanted.has(pr.pr)).map((pr)=>({...pr,id:`pr:${pr.pr}`,type:'pr',x:0,y:0,r:Math.min(10,5+Math.log2((pairDegree.get(pr.pr)||0)+1))}));
  const byPr = new Map(nodes.map((node)=>[node.pr,node]));
  nodes.forEach((node)=>{const candidates=(node.resources||[]).filter((key)=>resourceSet.has(key)).sort((a,b)=>(byResource.get(b).pairCount)-(byResource.get(a).pairCount));node.home=candidates[0];candidates.forEach((key)=>byResource.get(key).members.push(node));});
  const resourceNodes=[...byResource.values()];
  const resourceEdges=[];resourceNodes.forEach((resource)=>resource.members.forEach((node)=>resourceEdges.push({source:resource,target:node,home:node.home===resource.key})));
  const pairLinks=state.pairs.map((pair)=>({source:byPr.get(pair.prA),target:byPr.get(pair.prB),pair})).filter((link)=>link.source&&link.target);
  const dependencyLinks=(state.graph?.dependencies||[]).map((dependency)=>({source:byPr.get(dependency.from),target:byPr.get(dependency.to),dependency})).filter((link)=>link.source&&link.target);
  const neighbors=new Map(nodes.map((node)=>[node.pr,new Set()]));pairLinks.forEach(({source,target})=>{neighbors.get(source.pr).add(target.pr);neighbors.get(target.pr).add(source.pr);});dependencyLinks.forEach(({source,target})=>{neighbors.get(source.pr).add(target.pr);neighbors.get(target.pr).add(source.pr);});
  let w=0,h=0,dpr=1,worldW=0,worldH=0,hovered=null,focused=null,pointer=null,ignoreClickUntil=0;const camera={x:0,y:0,k:1};const panels=[];
  function layout(){panels.length=0;const panelW=Math.max(300,Math.min(410,w*.38)),gap=22,pad=20,nodeGap=30,nodeCols=Math.max(6,Math.floor((panelW-pad*2)/nodeGap));const panelCols=Math.max(1,Math.min(3,Math.floor((w*1.5)/panelW)));const columnY=Array(panelCols).fill(20);resourceNodes.forEach((resource,index)=>{const col=columnY.indexOf(Math.min(...columnY));const rows=Math.ceil(resource.members.length/nodeCols);const panelH=Math.max(112,84+rows*nodeGap);const x=20+col*(panelW+gap),y=columnY[col];columnY[col]+=panelH+gap;panels.push({resource,x,y,w:panelW,h:panelH});resource.x=x+panelW/2;resource.y=y+35;resource.size=Math.min(22,11+Math.log2(resource.count+1)*2);resource.members.filter((node)=>node.home===resource.key).forEach((node,index)=>{node.x=x+pad+(index%nodeCols)*nodeGap+nodeGap/2;node.y=y+83+Math.floor(index/nodeCols)*nodeGap;});});worldW=40+panelCols*panelW+(panelCols-1)*gap;worldH=Math.max(h,...columnY)+8;}
  function resize(initial=false){const box=canvas.getBoundingClientRect();w=Math.max(520,box.width);h=Math.max(520,box.height);dpr=window.devicePixelRatio||1;canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);layout();if(initial)fit();else draw();}
  function drawLine(ctx,source,target,color,dash,width,alpha,curved=true){ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(source.x,source.y);if(curved){const mid=(source.x+target.x)/2;ctx.bezierCurveTo(mid,source.y,mid,target.y,target.x,target.y);}else ctx.lineTo(target.x,target.y);ctx.stroke();}
  function visibleSet(){if(!focused)return null;if(focused.type==='resource'){const set=new Set([focused.id,...focused.members.map((node)=>node.id)]);focused.members.forEach((node)=>neighbors.get(node.pr)?.forEach((pr)=>set.add(`pr:${pr}`)));return set;}const set=new Set([focused.id,...(neighbors.get(focused.pr)||[])].map((value)=>String(value).startsWith('pr:')?value:`pr:${value}`));(focused.resources||[]).filter((key)=>resourceSet.has(key)).forEach((key)=>set.add(`resource:${key}`));return set;}
  function draw(){const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(camera.x,camera.y);ctx.scale(camera.k,camera.k);const visible=visibleSet();panels.forEach((panel,index)=>{ctx.globalAlpha=1;ctx.fillStyle=index%2?'#f8fafb':'#f4f7f8';ctx.strokeStyle='#dbe3e7';ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();ctx.roundRect(panel.x,panel.y,panel.w,panel.h,10);ctx.fill();ctx.stroke();});resourceEdges.forEach(({source,target,home})=>{const dimmed=visible&&!visible.has(source.id)&&!visible.has(target.id);drawLine(ctx,source,target,'#9eb1bd',home?[]:[2,4],home?1.15:.7,dimmed?.035:home?.42:.16,false);});pairLinks.forEach(({source,target,pair})=>{const verdict=pairVerdict(pair),meta=VERDICTS[verdict],incident=!focused||source===focused||target===focused;drawLine(ctx,source,target,meta.color,meta.dash,verdict==='conflict'?2.8:verdict==='possible_duplicate'?2.2:1.35,incident?(focused?.94:.38):.025);});dependencyLinks.forEach(({source,target})=>{const incident=!focused||source===focused||target===focused;drawLine(ctx,source,target,'#0f62fe',[6,4],1.8,incident?(focused?.96:.75):.03);});ctx.setLineDash([]);resourceNodes.forEach((resource)=>{const dimmed=visible&&!visible.has(resource.id);ctx.globalAlpha=dimmed?.17:1;ctx.fillStyle='#f8fbfd';ctx.strokeStyle=resource===focused?'#0f62fe':'#577284';ctx.lineWidth=resource===focused?3:1.4;ctx.fillRect(resource.x-resource.size/2,resource.y-resource.size/2,resource.size,resource.size);ctx.strokeRect(resource.x-resource.size/2,resource.y-resource.size/2,resource.size,resource.size);ctx.fillStyle='#263746';ctx.font='700 9px IBM Plex Mono, monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(resource.count),resource.x,resource.y);const label=resource.key.length>38?`${resource.key.slice(0,37)}…`:resource.key;ctx.font='9px IBM Plex Mono, monospace';ctx.fillStyle='#526472';ctx.fillText(label,resource.x,resource.y+resource.size/2+11);ctx.globalAlpha=1;});nodes.forEach((node)=>{const dimmed=visible&&!visible.has(node.id);ctx.globalAlpha=dimmed?.16:1;ctx.fillStyle=node.external?'#e7ecef':'#fff';ctx.strokeStyle=node===focused?'#0f62fe':'#172432';ctx.lineWidth=node===focused?3:1.35;ctx.setLineDash(node.external?[3,2]:[]);ctx.beginPath();ctx.arc(node.x,node.y,node.r+(node===focused?2:0),0,Math.PI*2);ctx.fill();ctx.stroke();ctx.setLineDash([]);if(node===focused||node===hovered||camera.k>1.45){const label=`#${node.pr}`;ctx.font=`${node===focused?'700':'600'} 9px IBM Plex Mono, monospace`;const tw=ctx.measureText(label).width;ctx.fillStyle='rgba(255,255,255,.94)';ctx.fillRect(node.x+node.r+4,node.y-7,tw+5,14);ctx.fillStyle='#263746';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(label,node.x+node.r+6,node.y);}ctx.globalAlpha=1;});ctx.restore();}
  function worldPoint(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left-camera.x)/camera.k,y:(event.clientY-rect.top-camera.y)/camera.k};}
  function hit(event){const point=worldPoint(event);let found=null,best=Infinity;[...nodes,...resourceNodes].forEach((node)=>{const distance=node.type==='resource'?Math.max(Math.abs(point.x-node.x),Math.abs(point.y-node.y)):Math.hypot(point.x-node.x,point.y-node.y);const threshold=node.type==='resource'?node.size/2+6/camera.k:node.r+7/camera.k;if(distance<threshold&&distance<best){found=node;best=distance;}});return found;}
  function segmentDistance(point,a,b){const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;if(!length)return Math.hypot(point.x-a.x,point.y-a.y);const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length));return Math.hypot(point.x-(a.x+t*dx),point.y-(a.y+t*dy));}
  function hitPair(event){const point=worldPoint(event);let found=null,best=Infinity;pairLinks.forEach((link)=>{let previous=link.source;const mid=(link.source.x+link.target.x)/2;for(let step=1;step<=12;step++){const t=step/12,mt=1-t;const current={x:mt*mt*mt*link.source.x+3*mt*mt*t*mid+3*mt*t*t*mid+t*t*t*link.target.x,y:mt*mt*mt*link.source.y+3*mt*mt*t*link.source.y+3*mt*t*t*link.target.y+t*t*t*link.target.y};const distance=segmentDistance(point,previous,current);if(distance<best){best=distance;found=link.pair;}previous=current;}});return best<Math.max(5,8/camera.k)?found:null;}
  function pairRows(pr){return state.pairs.filter((pair)=>pair.prA===pr||pair.prB===pr).sort((a,b)=>b.score-a.score);}
  function showPr(node){focused=node;draw();if(!node){inspector.innerHTML='<span class="network-kicker">RESOURCE-CENTRIC REVIEW MAP</span><h3>Select a resource or PR</h3><p>Resource hubs show affected pairs; a PR shows every semantic assessment candidate attached to it.</p>';return;}const rows=pairRows(node.pr);const hierarchy=node.hierarchy?.[0];inspector.innerHTML=`<div class="selected-pr-head"><div><span class="network-kicker">SELECTED PULL REQUEST</span><h3>#${node.pr} · ${esc(node.title||'Title unavailable')}</h3><p>${hierarchy?`${esc(hierarchy.sector)} / ${esc(hierarchy.domain)} / ${esc(hierarchy.subDomain||'unclassified')}`:'No classified hierarchy'} </p></div><div class="selected-pr-metrics"><b>${rows.length}</b><span>review candidates</span><b>${node.resources?.length||0}</b><span>touched resources</span></div></div>${rows.length?`<div class="assessment-stack-head"><h4>Semantic assessment candidates</h4><p>Evidence-backed hypotheses, awaiting semantic model or human verdict.</p></div><div class="assessment-stack">${rows.map((pair)=>relationCardHtml(pair,node.pr)).join('')}</div>`:'<div class="assessment-empty"><b>No review-queue relation</b><span>This PR passed Step 0, but no candidate pair reached the review queue.</span></div>'}<div class="graph-inspector-actions"><button class="primary graph-jump" data-graph-jump="${node.pr}">View matching review queue</button><button class="secondary graph-clear" data-graph-action="clear">Clear selection</button></div>`;}
  function showResource(resource){focused=resource;draw();const rows=state.pairs.filter((pair)=>pair.sharedResources.includes(resource.key)).sort((a,b)=>b.score-a.score);inspector.innerHTML=`<span class="network-kicker">SHARED RESOURCE HUB</span><h3>${esc(resource.key)}</h3><p>${fmt(resource.count)} Step 0 pass PRs touch this resource. ${fmt(rows.length)} pair candidates share it.</p><div class="graph-stat"><b>${resource.members.length}</b><span>shown PR branches</span><b>${rows.length}</b><span>review candidates</span></div>${rows.length?`<h4>Pair candidates on this resource</h4><div class="assessment-stack">${rows.map((pair)=>relationCardHtml(pair)).join('')}</div>`:'<div class="assessment-empty"><b>No candidate pair in the current queue</b></div>'}<div class="graph-inspector-actions"><button class="secondary graph-clear" data-graph-action="clear">Clear selection</button></div>`;}
  function inspect(node){if(!node)showPr(null);else if(node.type==='resource')showResource(node);else showPr(node);}
  function updateTooltip(event,node){hovered=node;if(!node){tooltip.classList.add('hidden');draw();return;}const rect=canvas.getBoundingClientRect();tooltip.innerHTML=node.type==='resource'?`<b>${esc(node.key)}</b><span>${node.count} pass PRs · ${node.pairCount} queue pairs</span>`:`<b>#${node.pr} · ${esc(node.title||'Title unavailable')}</b><span>${pairRows(node.pr).length} review candidates</span>`;tooltip.style.left=`${event.clientX-rect.left+14}px`;tooltip.style.top=`${event.clientY-rect.top+14}px`;tooltip.classList.remove('hidden');draw();}
  function onPointerDown(event){pointer={node:hit(event),startX:event.clientX,startY:event.clientY,camX:camera.x,camY:camera.y,moved:false};canvas.setPointerCapture(event.pointerId);}
  function onPointerMove(event){if(!pointer){updateTooltip(event,hit(event));return;}pointer.moved=pointer.moved||Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)>3;if(pointer.moved&&pointer.node){const point=worldPoint(event);pointer.node.x=point.x;pointer.node.y=point.y;draw();}else if(pointer.moved){camera.x=pointer.camX+event.clientX-pointer.startX;camera.y=pointer.camY+event.clientY-pointer.startY;draw();}}
  function onPointerUp(event){ignoreClickUntil=pointer?.moved?Date.now()+150:0;pointer=null;canvas.releasePointerCapture?.(event.pointerId);}
  function onClick(event){if(Date.now()<ignoreClickUntil)return;const node=hit(event);if(!node){const pair=hitPair(event);if(pair){void openPairModal(pairId(pair));return;}}inspect(!node||node===focused?null:node);}
  function onKeydown(event){if(event.key==='Escape')inspect(null);}
  function onWheel(event){event.preventDefault();const rect=canvas.getBoundingClientRect(),sx=event.clientX-rect.left,sy=event.clientY-rect.top,old=camera.k,next=Math.max(.08,Math.min(5,old*Math.exp(-event.deltaY*.001)));camera.x=sx-(sx-camera.x)*next/old;camera.y=sy-(sy-camera.y)*next/old;camera.k=next;draw();}
  function fit(){const k=Math.min(1,(w-28)/Math.max(1,worldW),(h-28)/Math.max(1,worldH));camera.k=k;camera.x=(w-worldW*k)/2;camera.y=(h-worldH*k)/2;draw();}
  function onCardClick(event){const mode=event.target.closest('[data-map-mode]')?.dataset.mapMode;if(mode&&mode!==state.mapMode){state.mapMode=mode;renderMap();return;}const action=event.target.closest('[data-graph-action]')?.dataset.graphAction;if(action==='fit')fit();if(action==='clear')inspect(null);const hot=event.target.closest('[data-hot-resource]')?.dataset.hotResource;if(hot&&byResource.has(hot))showResource(byResource.get(hot));const pair=event.target.closest('[data-map-pair]')?.dataset.mapPair;if(pair){void openPairModal(pair);return;}const jump=event.target.closest('[data-graph-jump]')?.dataset.graphJump;if(jump){state.search=jump;$('#search-input').value=jump;state.view='queue';$('#content').scrollTop=0;renderView();}}
  canvas.addEventListener('pointerdown',onPointerDown);canvas.addEventListener('pointermove',onPointerMove);canvas.addEventListener('pointerup',onPointerUp);canvas.addEventListener('pointercancel',onPointerUp);canvas.addEventListener('click',onClick);canvas.addEventListener('keydown',onKeydown);canvas.addEventListener('wheel',onWheel,{passive:false});card.addEventListener('click',onCardClick);window.addEventListener('resize',resize);resize(true);
  return {destroy(){canvas.removeEventListener('pointerdown',onPointerDown);canvas.removeEventListener('pointermove',onPointerMove);canvas.removeEventListener('pointerup',onPointerUp);canvas.removeEventListener('pointercancel',onPointerUp);canvas.removeEventListener('click',onClick);canvas.removeEventListener('keydown',onKeydown);canvas.removeEventListener('wheel',onWheel);card.removeEventListener('click',onCardClick);window.removeEventListener('resize',resize);},fit,stats:{nodes:nodes.length+resourceNodes.length,edges:resourceEdges.length+pairLinks.length+dependencyLinks.length,prs:nodes.length,resources:resourceNodes.length}};
}
function drawRelationGraph() {
  const canvas = $('#resource-graph'); if (!canvas) return null;
  const inspector = $('#graph-inspector'); const tooltip = $('#graph-tooltip'); const card = canvas.closest('.network-card');
  const rawPrs = [...(state.graph?.prs || []), ...(state.graph?.externalPrs || []).map((pr) => ({...pr, external:true, hierarchy:[{sector:'external:stack',domain:'dependency-target',subDomain:pr.verdict}],resources:[]}))];
  const fallback = [...new Map(state.pairs.flatMap((pair) => [[pair.prA,{pr:pair.prA,title:pair.titleA,hierarchy:[],resources:pair.sharedResources}],[pair.prB,{pr:pair.prB,title:pair.titleB,hierarchy:[],resources:pair.sharedResources}]])).values()];
  const prs = rawPrs.length ? rawPrs : fallback;
  const pairDegree = new Map(); state.pairs.forEach((pair) => { pairDegree.set(pair.prA,(pairDegree.get(pair.prA)||0)+1); pairDegree.set(pair.prB,(pairDegree.get(pair.prB)||0)+1); });
  const nodes = prs.map((pr) => ({...pr,id:`pr:${pr.pr}`,x:0,y:0,r:Math.min(10,5+Math.log2((pairDegree.get(pr.pr)||0)+1))}));
  const byPr = new Map(nodes.map((node) => [node.pr,node]));
  const pairLinks = state.pairs.map((pair) => ({source:byPr.get(pair.prA),target:byPr.get(pair.prB),pair})).filter((link) => link.source&&link.target);
  const dependencyLinks = (state.graph?.dependencies || []).map((dependency) => ({source:byPr.get(dependency.from),target:byPr.get(dependency.to),dependency})).filter((link) => link.source&&link.target);
  const neighbors = new Map(nodes.map((node) => [node.pr,new Set()]));
  pairLinks.forEach(({source,target}) => { neighbors.get(source.pr).add(target.pr); neighbors.get(target.pr).add(source.pr); });
  dependencyLinks.forEach(({source,target}) => { neighbors.get(source.pr).add(target.pr); neighbors.get(target.pr).add(source.pr); });
  const sectorOf = (node) => node.hierarchy?.[0]?.sector || 'unclassified';
  const sectors = [...new Set(nodes.map(sectorOf))].map((name) => ({name,nodes:nodes.filter((node)=>sectorOf(node)===name).sort((a,b)=>(pairDegree.get(b.pr)||0)-(pairDegree.get(a.pr)||0)||a.pr-b.pr)})).sort((a,b)=>b.nodes.length-a.nodes.length||a.name.localeCompare(b.name));
  let w=0,h=0,dpr=1,worldW=0,worldH=0,hovered=null,focused=null,pointer=null,ignoreClickUntil=0;
  const camera={x:0,y:0,k:1}; const panels=[];
  function layout() {
    panels.length=0; const panelW=Math.max(360,Math.min(460,w*.42)); const panelCols=Math.max(1,Math.min(4,Math.floor((w*1.6)/panelW)));
    const gap=20,pad=22,nodeGap=28,nodeCols=Math.max(8,Math.floor((panelW-pad*2)/nodeGap)); const columnY=Array(panelCols).fill(20);
    sectors.forEach((sector,index)=>{const col=index%panelCols;const rows=Math.ceil(sector.nodes.length/nodeCols);const panelH=Math.max(92,64+rows*nodeGap);const x=20+col*(panelW+gap);const y=columnY[col];columnY[col]+=panelH+gap;panels.push({name:sector.name,count:sector.nodes.length,x,y,w:panelW,h:panelH});sector.nodes.forEach((node,i)=>{node.x=x+pad+(i%nodeCols)*nodeGap+nodeGap/2;node.y=y+52+Math.floor(i/nodeCols)*nodeGap;});});
    worldW=40+panelCols*panelW+(panelCols-1)*gap;worldH=Math.max(h,...columnY)+8;
  }
  function resize(initial=false){const box=canvas.getBoundingClientRect();w=Math.max(520,box.width);h=Math.max(520,box.height);dpr=window.devicePixelRatio||1;canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);layout();if(initial)fit();else draw();}
  function drawLine(ctx,source,target,color,dash,width,alpha){ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.setLineDash(dash);ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(source.x,source.y);const mx=(source.x+target.x)/2;ctx.bezierCurveTo(mx,source.y,mx,target.y,target.x,target.y);ctx.stroke();}
  function draw(){const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(camera.x,camera.y);ctx.scale(camera.k,camera.k);const visible=focused?new Set([focused.pr,...neighbors.get(focused.pr)]):null;
    panels.forEach((panel,index)=>{ctx.globalAlpha=1;ctx.fillStyle=index%2?'#f8fafb':'#f4f7f8';ctx.strokeStyle='#dbe3e7';ctx.lineWidth=1;ctx.setLineDash([]);ctx.beginPath();ctx.roundRect(panel.x,panel.y,panel.w,panel.h,10);ctx.fill();ctx.stroke();ctx.fillStyle='#263746';ctx.font='700 11px IBM Plex Mono, monospace';ctx.textAlign='left';ctx.textBaseline='middle';const label=panel.name.length>38?`${panel.name.slice(0,37)}…`:panel.name;ctx.fillText(label,panel.x+14,panel.y+19);ctx.fillStyle='#7b8993';ctx.font='9px IBM Plex Mono, monospace';ctx.fillText(`${panel.count} PRs`,panel.x+14,panel.y+36);});
    pairLinks.forEach(({source,target,pair})=>{const verdict=pairVerdict(pair),meta=VERDICTS[verdict],incident=!focused||source===focused||target===focused;drawLine(ctx,source,target,meta.color,meta.dash,verdict==='conflict'?2.8:verdict==='possible_duplicate'?2.2:1.35,incident?(focused?.92:.24):.025);});
    dependencyLinks.forEach(({source,target})=>{const incident=!focused||source===focused||target===focused;drawLine(ctx,source,target,'#0f62fe',[6,4],1.8,incident?(focused?.95:.55):.03);});ctx.setLineDash([]);
    nodes.forEach((node)=>{const dimmed=visible&&!visible.has(node.pr);ctx.globalAlpha=dimmed?.16:1;const judgedRelations=state.pairs.filter((pair)=>(pair.prA===node.pr||pair.prB===node.pr)&&pairVerdict(pair)!=='unreviewed');const ring=judgedRelations.find((pair)=>pairVerdict(pair)==='conflict')?'#d6453a':judgedRelations.find((pair)=>pairVerdict(pair)==='possible_duplicate')?'#7a4fd6':'#172432';ctx.fillStyle=node.external?'#e7ecef':'#fff';ctx.strokeStyle=node===focused?'#0f62fe':ring;ctx.lineWidth=node===focused?3:1.5;ctx.setLineDash(node.external?[3,2]:[]);ctx.beginPath();ctx.arc(node.x,node.y,node.r+(node===focused?2:0),0,Math.PI*2);ctx.fill();ctx.stroke();ctx.setLineDash([]);const show=node===focused||node===hovered||camera.k>1.45;if(show){const label=`#${node.pr}`;ctx.font=`${node===focused?'700':'600'} 9px IBM Plex Mono, monospace`;const tw=ctx.measureText(label).width;ctx.fillStyle='rgba(255,255,255,.94)';ctx.fillRect(node.x+node.r+4,node.y-7,tw+5,14);ctx.fillStyle='#263746';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(label,node.x+node.r+6,node.y);}ctx.globalAlpha=1;});ctx.restore();}
  function worldPoint(event){const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left-camera.x)/camera.k,y:(event.clientY-rect.top-camera.y)/camera.k};}
  function hit(event){const point=worldPoint(event);let found=null,best=Infinity;nodes.forEach((node)=>{const distance=Math.hypot(point.x-node.x,point.y-node.y);if(distance<node.r+7/camera.k&&distance<best){found=node;best=distance;}});return found;}
  function pairRowsForPr(pr){return state.pairs.filter((pair)=>pair.prA===pr||pair.prB===pr).sort((a,b)=>{const order={conflict:0,uncertain:1,unreviewed:2,possible_duplicate:3,harmless:4};return order[pairVerdict(a)]-order[pairVerdict(b)]||b.score-a.score;});}
  function showPr(node){focused=node;draw();if(!node){inspector.innerHTML='<span class="network-kicker">SEMANTIC ASSESSMENT STACK</span><h3>Select a PR</h3><p>Its review candidates will appear here with type, evidence, hypothesis, and current verdict.</p>';return;}const rows=pairRowsForPr(node.pr);const hierarchy=node.hierarchy?.[0];inspector.innerHTML=`<div class="selected-pr-head"><div><span class="network-kicker">SELECTED PULL REQUEST</span><h3>#${node.pr} · ${esc(node.title||'Title unavailable')}</h3><p>${hierarchy?`${esc(hierarchy.sector)} / ${esc(hierarchy.domain)} / ${esc(hierarchy.subDomain||'unclassified')}`:'Unclassified'}${node.external?' · dependency target outside Step 0 pass':''}</p></div><div class="selected-pr-metrics"><b>${rows.length}</b><span>review candidates</span><b>${node.resources?.length||0}</b><span>touched resources</span></div></div>${rows.length?`<div class="assessment-stack-head"><h4>Semantic assessment candidates</h4><p>These are evidence-backed hypotheses awaiting a semantic model or human verdict.</p></div><div class="assessment-stack">${rows.map((pair)=>relationCardHtml(pair,node.pr)).join('')}</div>`:'<div class="assessment-empty"><b>No review-queue relation</b><span>This PR passed Step 0 but no candidate pair survived retrieval and the review budget.</span></div>'}<div class="graph-inspector-actions"><button class="primary graph-jump" data-graph-jump="${node.pr}">View matching review queue</button><button class="secondary graph-clear" data-graph-action="clear">Clear selection</button></div>`;}
  function showResource(key){focused=null;draw();const rows=state.pairs.filter((pair)=>pair.sharedResources.includes(key)).sort((a,b)=>b.score-a.score);const resource=(state.graph?.resources||[]).find((item)=>item.key===key);inspector.innerHTML=`<span class="network-kicker">HOT RESOURCE</span><h3>${esc(key)}</h3><p>${fmt(resource?.count||0)} pass PRs touch this resource. The cards below are the queue pairs that share it.</p>${rows.length?`<div class="assessment-stack">${rows.map((pair)=>relationCardHtml(pair)).join('')}</div>`:'<div class="assessment-empty"><b>No review-queue relation</b></div>'}`;}
  function updateTooltip(event,node){hovered=node;if(!node){tooltip.classList.add('hidden');draw();return;}const rect=canvas.getBoundingClientRect(),rows=pairRowsForPr(node.pr);tooltip.innerHTML=`<b>#${node.pr} · ${esc(node.title||'Title unavailable')}</b><span>${esc(sectorOf(node))} · ${rows.length} review candidates</span>`;tooltip.style.left=`${event.clientX-rect.left+14}px`;tooltip.style.top=`${event.clientY-rect.top+14}px`;tooltip.classList.remove('hidden');draw();}
  function onPointerDown(event){pointer={node:hit(event),startX:event.clientX,startY:event.clientY,camX:camera.x,camY:camera.y,moved:false};canvas.setPointerCapture(event.pointerId);}
  function onPointerMove(event){if(!pointer){updateTooltip(event,hit(event));return;}pointer.moved=pointer.moved||Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)>3;if(pointer.moved){camera.x=pointer.camX+event.clientX-pointer.startX;camera.y=pointer.camY+event.clientY-pointer.startY;draw();}}
  function onPointerUp(event){ignoreClickUntil=pointer?.moved?Date.now()+150:0;pointer=null;canvas.releasePointerCapture?.(event.pointerId);}
  function onCanvasClick(event){if(Date.now()<ignoreClickUntil)return;const node=hit(event);showPr(!node||node===focused?null:node);}
  function onWheel(event){event.preventDefault();const rect=canvas.getBoundingClientRect(),sx=event.clientX-rect.left,sy=event.clientY-rect.top,old=camera.k,next=Math.max(.08,Math.min(5,old*Math.exp(-event.deltaY*.001)));camera.x=sx-(sx-camera.x)*next/old;camera.y=sy-(sy-camera.y)*next/old;camera.k=next;draw();}
  function fit(){const k=Math.min(1,(w-28)/Math.max(1,worldW),(h-28)/Math.max(1,worldH));camera.k=k;camera.x=(w-worldW*k)/2;camera.y=(h-worldH*k)/2;draw();}
  function onCardClick(event){const mode=event.target.closest('[data-map-mode]')?.dataset.mapMode;if(mode&&mode!==state.mapMode){state.mapMode=mode;renderMap();return;}const action=event.target.closest('[data-graph-action]')?.dataset.graphAction;if(action==='fit')fit();if(action==='clear')showPr(null);const hot=event.target.closest('[data-hot-resource]')?.dataset.hotResource;if(hot)showResource(hot);const pair=event.target.closest('[data-map-pair]')?.dataset.mapPair;if(pair){void openPairModal(pair);return;}const jump=event.target.closest('[data-graph-jump]')?.dataset.graphJump;if(jump){state.search=jump;$('#search-input').value=jump;state.view='queue';$('#content').scrollTop=0;renderView();}}
  canvas.addEventListener('pointerdown',onPointerDown);canvas.addEventListener('pointermove',onPointerMove);canvas.addEventListener('pointerup',onPointerUp);canvas.addEventListener('pointercancel',onPointerUp);canvas.addEventListener('click',onCanvasClick);canvas.addEventListener('keydown',(event)=>{if(event.key==='Escape')showPr(null);});canvas.addEventListener('wheel',onWheel,{passive:false});card.addEventListener('click',onCardClick);window.addEventListener('resize',resize);resize(true);
  return {destroy(){canvas.removeEventListener('pointerdown',onPointerDown);canvas.removeEventListener('pointermove',onPointerMove);canvas.removeEventListener('pointerup',onPointerUp);canvas.removeEventListener('pointercancel',onPointerUp);canvas.removeEventListener('click',onCanvasClick);canvas.removeEventListener('wheel',onWheel);card.removeEventListener('click',onCardClick);window.removeEventListener('resize',resize);},fit,focusPr(number){const node=byPr.get(number);if(node)showPr(node);},stats:{nodes:nodes.length,edges:pairLinks.length+dependencyLinks.length,prs:nodes.length}};
}
function drawGraph() {
  const canvas = $('#resource-graph'); if (!canvas) return null;
  const inspector = $('#graph-inspector'); const tooltip = $('#graph-tooltip'); const card = canvas.closest('.network-card');
  const graphPrs = state.graph?[...state.graph.prs,...(state.graph.externalPrs||[]).map((pr)=>({...pr,external:true,hierarchy:[{sector:'external:stack',domain:'dependency-target',subDomain:pr.verdict}],resources:[]}))]:[...new Map(state.pairs.flatMap((pair) => [[pair.prA,{pr:pair.prA,title:pair.titleA,hierarchy:[],resources:pair.sharedResources}],[pair.prB,{pr:pair.prB,title:pair.titleB,hierarchy:[],resources:pair.sharedResources}]])).values()];
  const nodes = [], byId = new Map();
  const addNode = (type, raw, label = raw, degree = 1, sortKey = String(raw)) => { const id=`${type}:${raw}`;const existing=byId.get(id);if(existing){existing.degree=Math.max(existing.degree,degree);return existing;}const node={id,raw,type,label,degree,sortKey,x:0,y:0,vx:0,vy:0,fixed:false};nodes.push(node);byId.set(id,node);return node; };
  const structuralLinks = [], structuralKeys = new Set();
  const addStructural = (sourceId,targetId,kind) => {const key=`${sourceId}>${targetId}`;if(structuralKeys.has(key)||!byId.has(sourceId)||!byId.has(targetId))return;structuralKeys.add(key);structuralLinks.push({source:byId.get(sourceId),target:byId.get(targetId),kind});};
  const resourceMeta = new Map((state.graph?.resources || []).map((resource) => [resource.key,resource]));
  const queueResourceCount = new Map();
  state.pairs.forEach((pair)=>pair.sharedResources.forEach((key)=>queueResourceCount.set(key,(queueResourceCount.get(key)||0)+1)));
  const globalHot=(state.graph?.resources||[]).map((resource)=>({...resource,pairCount:state.pairs.filter((pair)=>pair.sharedResources.includes(resource.key)).length})).filter((resource)=>resource.count>1&&resource.pairCount>0).sort((a,b)=>b.pairCount-a.pairCount||b.count-a.count).slice(0,12).map((resource)=>resource.key);
  const queueHot=[...queueResourceCount.keys()].sort((a,b)=>(queueResourceCount.get(b)||0)-(queueResourceCount.get(a)||0)||(resourceMeta.get(b)?.count||0)-(resourceMeta.get(a)?.count||0)||a.localeCompare(b));
  const hotResources=[];
  const hotSet = new Set(hotResources);
  for(const pr of graphPrs){
    const hierarchyRows=pr.hierarchy?.length?pr.hierarchy:[{sector:'unclassified',domain:'unclassified',subDomain:'unclassified'}];
    const primary=hierarchyRows[0];const sortKey=`${primary.sector}/${primary.domain}/${primary.subDomain}/${String(pr.pr).padStart(12,'0')}`;
    const prNode=addNode('pr',pr.pr,`#${pr.pr}`,Math.max(1,state.pairs.filter((pair)=>pair.prA===pr.pr||pair.prB===pr.pr).length),sortKey);prNode.external=Boolean(pr.external);
    for(const row of hierarchyRows){const domain=`${row.sector}/${row.domain}`;const subDomain=`${domain}/${row.subDomain||'unclassified'}`;addNode('sector',row.sector,row.sector);addNode('domain',domain,row.domain||'unclassified');addNode('subdomain',subDomain,row.subDomain||'unclassified');}
  }
  hotResources.forEach((key)=>addNode('resource',key,key,resourceMeta.get(key)?.count||queueResourceCount.get(key)||1,`${String(999999-(resourceMeta.get(key)?.count||0)).padStart(8,'0')}/${key}`));
  for(const pr of graphPrs){
    const hierarchyRows=pr.hierarchy?.length?pr.hierarchy:[{sector:'unclassified',domain:'unclassified',subDomain:'unclassified'}];
    for(const row of hierarchyRows){const domain=`${row.sector}/${row.domain}`;const subDomain=`${domain}/${row.subDomain||'unclassified'}`;addStructural(`sector:${row.sector}`,`domain:${domain}`,'hierarchy');addStructural(`domain:${domain}`,`subdomain:${subDomain}`,'hierarchy');addStructural(`subdomain:${subDomain}`,`pr:${pr.pr}`,'classification');}
    for(const resource of pr.resources||[])if(hotSet.has(resource))addStructural(`pr:${pr.pr}`,`resource:${resource}`,'contact');
  }
  const pairLinks=[];
  const dependencyLinks=[];
  const neighbors = new Map(nodes.map((node)=>[node.id,new Set()]));
  [...structuralLinks,...pairLinks,...dependencyLinks].forEach(({source,target})=>{neighbors.get(source.id)?.add(target.id);neighbors.get(target.id)?.add(source.id);});
  canvas.dataset.nodes=String(nodes.length);canvas.dataset.edges=String(structuralLinks.length+pairLinks.length+dependencyLinks.length);canvas.dataset.prs=String(graphPrs.length);
  let w=0,h=0,layoutH=0,dpr=1,raf=0,alpha=1,hovered=null,focused=null,pointer=null,ignoreClickUntil=0;
  const forceLayout=nodes.length<=420;let running=forceLayout;
  const camera = { x:0, y:0, k:1 };
  const colors = { sector:'#0f62fe', domain:'#7546c9', subdomain:'#008f95', pr:'#172432', resource:'#d88a00' };
  const radius = (node) => ({sector:10,domain:8,subdomain:7,pr:6,resource:6}[node.type] + Math.min(4,Math.log2(node.degree + 1)));
  const anchors = { sector:.055, domain:.255, subdomain:.46, pr:.69, resource:.94 };
  function resize(initial = false) {
    const oldW=w||1;const box=canvas.getBoundingClientRect(); w=Math.max(520,box.width);h=Math.max(520,box.height);dpr=window.devicePixelRatio||1;
    canvas.width = Math.floor(w*dpr); canvas.height = Math.floor(h*dpr);
    if (initial) {
      const groups = ['sector','domain','subdomain','pr','resource'];
      const maxGroup=Math.max(...groups.map((type)=>nodes.filter((node)=>node.type===type).length));layoutH=forceLayout?h:Math.max(h,maxGroup*15+80);
      groups.forEach((type)=>{const rows=nodes.filter((node)=>node.type===type).sort((a,b)=>a.sortKey.localeCompare(b.sortKey));rows.forEach((node,index)=>{const jitter=forceLayout?(((index*37)%11)-5)*2:0;node.x=w*anchors[type]+jitter;node.y=40+(index+.5)*(layoutH-80)/Math.max(1,rows.length);});});
      if(!forceLayout)fit();
    } else {nodes.forEach((node)=>{node.x*=w/oldW;});}
    draw();
  }
  function tick() {
    if (forceLayout&&running&&alpha>.012) {
      for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) { const a=nodes[i], b=nodes[j]; let dx=a.x-b.x, dy=a.y-b.y; const d2=Math.max(100,dx*dx+dy*dy), force=1500/d2; const d=Math.sqrt(d2); a.vx+=dx/d*force; a.vy+=dy/d*force; b.vx-=dx/d*force; b.vy-=dy/d*force; }
      structuralLinks.forEach(({source,target,kind})=>{const dx=target.x-source.x,dy=target.y-source.y,dist=Math.max(1,Math.hypot(dx,dy)),desired=kind==='hierarchy'?125:kind==='classification'?130:145,force=(dist-desired)*.005*alpha;source.vx+=dx/dist*force;source.vy+=dy/dist*force;target.vx-=dx/dist*force;target.vy-=dy/dist*force;});
      nodes.forEach((node)=>{if(node.fixed)return;node.vx+=(w*anchors[node.type]-node.x)*.011;node.vy+=(h/2-node.y)*.00016;node.vx*=.84;node.vy*=.84;node.x+=node.vx;node.y+=node.vy;node.x=Math.max(24,Math.min(w-24,node.x));node.y=Math.max(24,Math.min(layoutH-24,node.y));});
      alpha *= .988;
    }
    draw();if(forceLayout)raf=requestAnimationFrame(tick);
  }
  function worldPoint(event) { const rect=canvas.getBoundingClientRect(); return { x:(event.clientX-rect.left-camera.x)/camera.k, y:(event.clientY-rect.top-camera.y)/camera.k }; }
  function hit(event) { const p=worldPoint(event); let found=null,best=Infinity; nodes.forEach((node) => { const d=Math.hypot(p.x-node.x,p.y-node.y); if(d<radius(node)+5/camera.k&&d<best){found=node;best=d;} }); return found; }
  function drawNode(ctx,node,dimmed) {
    const r=radius(node); ctx.globalAlpha=dimmed?.18:1; ctx.fillStyle=node.type==='pr'?(node.external?'#e9eef0':'#fff'):colors[node.type];ctx.strokeStyle=node.external?'#7d8992':colors[node.type];ctx.lineWidth=node===focused||node===hovered?3:1.5;ctx.setLineDash(node.external?[3,2]:[]);
    if(node.type==='resource'){ctx.fillRect(node.x-r,node.y-r,r*2,r*2);ctx.strokeRect(node.x-r,node.y-r,r*2,r*2);}else{ctx.beginPath();ctx.arc(node.x,node.y,r,0,Math.PI*2);ctx.fill();ctx.stroke();}
    const important=node===focused||node===hovered||(node.type==='pr'?camera.k>1.3:camera.k>.55)||(camera.k>.2&&node.type!=='pr'&&node.degree>=4);
    if(important){ctx.font=`${node===focused?'600 ':' '}10px IBM Plex Mono, monospace`;ctx.textBaseline='middle';const max=node.type==='domain'?18:node.type==='subdomain'?18:node.type==='resource'?22:16;const label=node.label.length>max?`${node.label.slice(0,max-1)}…`:node.label;const tw=ctx.measureText(label).width;const right=node.type!=='resource';const tx=node.x+(right?r+6:-r-6);ctx.fillStyle='rgba(251,252,253,.9)';ctx.fillRect(right?tx-2:tx-tw-2,node.y-7,tw+4,14);ctx.fillStyle='#263746';ctx.textAlign=right?'left':'right';ctx.fillText(label,tx,node.y);}
    ctx.setLineDash([]);ctx.globalAlpha=1;
  }
  function draw() {
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(camera.x,camera.y);ctx.scale(camera.k,camera.k);
    const visible=focused?new Set([focused.id,...neighbors.get(focused.id)]):null;
    structuralLinks.forEach(({source,target,kind})=>{const dimmed=visible&&!visible.has(source.id)&&!visible.has(target.id);ctx.globalAlpha=dimmed?.035:kind==='contact'?.11:.13;ctx.setLineDash([]);ctx.strokeStyle=kind==='contact'?'#0f62fe':kind==='classification'?'#008f95':'#75838d';ctx.lineWidth=(source===focused||target===focused)?2:1;ctx.beginPath();ctx.moveTo(source.x,source.y);ctx.lineTo(target.x,target.y);ctx.stroke();});
    dependencyLinks.forEach(({source,target})=>{ctx.globalAlpha=visible&&!(visible.has(source.id)||visible.has(target.id))?.05:.75;ctx.strokeStyle='#0f62fe';ctx.setLineDash([5,4]);ctx.lineWidth=1.7;ctx.beginPath();ctx.moveTo(source.x,source.y);ctx.bezierCurveTo(source.x+38,source.y,target.x+38,target.y,target.x,target.y);ctx.stroke();});
    pairLinks.forEach(({source,target,pair})=>{const verdict=pairVerdict(pair),meta=VERDICTS[verdict];ctx.globalAlpha=visible&&!(visible.has(source.id)||visible.has(target.id))?.04:verdict==='harmless'?.28:.78;ctx.strokeStyle=meta.color;ctx.setLineDash(meta.dash);ctx.lineWidth=verdict==='conflict'?2.7:verdict==='possible_duplicate'?2.2:1.5;const bend=35+Math.min(100,Math.abs(target.y-source.y)*.12);ctx.beginPath();ctx.moveTo(source.x,source.y);ctx.bezierCurveTo(source.x+bend,source.y,target.x+bend,target.y,target.x,target.y);ctx.stroke();});ctx.setLineDash([]);ctx.globalAlpha=1;
    nodes.forEach((node)=>drawNode(ctx,node,visible&&!visible.has(node.id)));ctx.restore();
  }
  function relatedPairs(node){if(node.type==='pr')return state.pairs.filter((pair)=>pair.prA===node.raw||pair.prB===node.raw);if(node.type==='resource')return state.pairs.filter((pair)=>pair.sharedResources.includes(node.raw));return [];}
  function pairStack(rows,node){return rows.sort((a,b)=>{const order={conflict:0,uncertain:1,unreviewed:1,possible_duplicate:2,harmless:3};return order[pairVerdict(a)]-order[pairVerdict(b)]||b.score-a.score;}).slice(0,20).map((pair)=>relationCardHtml(pair,node?.type==='pr'?node.raw:null)).join('');}
  function inspect(node) {
    focused=node;draw();
    if(!node){inspector.innerHTML='<span class="network-kicker">RELATION STACK</span><h3>Select a PR or resource</h3><p>Inspect hierarchy links and pair relationships, then open a pair for human judgment.</p>';return;}
    const connected=[...neighbors.get(node.id)].map((id)=>byId.get(id)).sort((a,b)=>b.degree-a.degree); const typeLabel={sector:'Sector',domain:'Domain',subdomain:'Sub-domain',pr:'Pull request',resource:'Touched resource'}[node.type];
    const prData=node.type==='pr'?graphPrs.find((pr)=>pr.pr===node.raw):null;const pairs=relatedPairs(node);const description=node.type==='pr'?`${prData?.title||'Title unavailable'}${prData?.external?` · stack target outside Step 0 pass (${prData.verdict})`:''}`:node.type==='resource'?`${fmt(resourceMeta.get(node.raw)?.count||node.degree)} pass PRs touch this resource.`:`${fmt(connected.length)} direct hierarchy connections.`;
    inspector.innerHTML=`<span class="network-kicker">${typeLabel.toUpperCase()}</span><h3>${esc(node.label)}</h3><p>${esc(description)}</p><div class="graph-stat"><b>${connected.length}</b><span>hierarchy connections</span><b>${pairs.length}</b><span>review candidates</span></div>${pairs.length?`<h4>Semantic assessment candidates</h4><div class="assessment-stack">${pairStack(pairs,node)}</div>`:''}<h4>Classification stack</h4><div class="graph-connections">${connected.filter((item)=>item.type!=='pr'||node.type!=='pr').slice(0,18).map((item)=>`<button data-focus-node="${esc(item.id)}"><i style="--node-color:${colors[item.type]}"></i>${esc(item.label)}</button>`).join('')}</div><div class="graph-inspector-actions"><button class="primary graph-jump" data-graph-jump="${esc(String(node.raw))}">View matching review queue</button><button class="secondary graph-clear" data-graph-action="clear">Clear selection</button></div>`;
  }
  function updateTooltip(event,node){hovered=node; if(!node){tooltip.classList.add('hidden');draw();return;} const rect=canvas.getBoundingClientRect();tooltip.innerHTML=`<b>${esc(node.label)}</b><span>${node.type} · ${neighbors.get(node.id).size} connections</span>`;tooltip.style.left=`${event.clientX-rect.left+14}px`;tooltip.style.top=`${event.clientY-rect.top+14}px`;tooltip.classList.remove('hidden');draw();}
  function onPointerDown(event){const node=hit(event);const p=worldPoint(event);pointer={node,startX:event.clientX,startY:event.clientY,worldX:p.x,worldY:p.y,camX:camera.x,camY:camera.y,moved:false};canvas.setPointerCapture(event.pointerId);}
  function onPointerMove(event){if(!pointer){updateTooltip(event,hit(event));return;}pointer.moved=pointer.moved||Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)>3;if(pointer.node&&pointer.moved){pointer.node.fixed=true;const p=worldPoint(event);pointer.node.x=p.x;pointer.node.y=p.y;pointer.node.vx=0;pointer.node.vy=0;}else if(!pointer.node&&pointer.moved){camera.x=pointer.camX+event.clientX-pointer.startX;camera.y=pointer.camY+event.clientY-pointer.startY;}draw();}
  function onPointerUp(event){ignoreClickUntil=pointer?.moved?Date.now()+150:0;pointer=null;canvas.releasePointerCapture?.(event.pointerId);}
  function onCanvasClick(event){if(Date.now()<ignoreClickUntil)return;const node=hit(event);inspect(!node||node===focused?null:node);}
  function onCanvasKeydown(event){if(event.key==='Escape')inspect(null);}
  function onWheel(event){event.preventDefault();const rect=canvas.getBoundingClientRect(),sx=event.clientX-rect.left,sy=event.clientY-rect.top,old=camera.k,next=Math.max(.012,Math.min(6,old*Math.exp(-event.deltaY*.001)));camera.x=sx-(sx-camera.x)*next/old;camera.y=sy-(sy-camera.y)*next/old;camera.k=next;draw();}
  function fit(){const k=Math.min(1,(w-28)/w,(h-28)/Math.max(h,layoutH));camera.k=k;camera.x=(w-w*k)/2;camera.y=(h-layoutH*k)/2;draw();}
  function onCardClick(event){const mode=event.target.closest('[data-map-mode]')?.dataset.mapMode;if(mode&&mode!==state.mapMode){state.mapMode=mode;renderMap();return;}const action=event.target.closest('[data-graph-action]')?.dataset.graphAction;if(action==='fit')fit();if(action==='clear')inspect(null);if(action==='physics'&&forceLayout){running=!running;event.target.classList.toggle('active',running);event.target.setAttribute('aria-pressed',String(running));event.target.textContent=running?'Pause layout':'Resume layout';if(running)alpha=Math.max(alpha,.28);}const focusId=event.target.closest('[data-focus-node]')?.dataset.focusNode;if(focusId&&byId.has(focusId))inspect(byId.get(focusId));const pair=event.target.closest('[data-map-pair]')?.dataset.mapPair;if(pair){void openPairModal(pair);return;}const jump=event.target.closest('[data-graph-jump]')?.dataset.graphJump;if(jump){state.search=jump;$('#search-input').value=jump;state.view='queue';$('#content').scrollTop=0;renderView();}}
  canvas.addEventListener('pointerdown',onPointerDown);canvas.addEventListener('pointermove',onPointerMove);canvas.addEventListener('pointerup',onPointerUp);canvas.addEventListener('pointercancel',onPointerUp);canvas.addEventListener('click',onCanvasClick);canvas.addEventListener('keydown',onCanvasKeydown);canvas.addEventListener('wheel',onWheel,{passive:false});card.addEventListener('click',onCardClick);window.addEventListener('resize',resize);
  resize(true);const physicsButton=card.querySelector('[data-graph-action="physics"]');if(!forceLayout){physicsButton.disabled=true;physicsButton.classList.remove('active');physicsButton.textContent='Static full stack';}if(forceLayout)tick();else draw();
  return { destroy(){cancelAnimationFrame(raf);canvas.removeEventListener('pointerdown',onPointerDown);canvas.removeEventListener('pointermove',onPointerMove);canvas.removeEventListener('pointerup',onPointerUp);canvas.removeEventListener('pointercancel',onPointerUp);canvas.removeEventListener('click',onCanvasClick);canvas.removeEventListener('keydown',onCanvasKeydown);canvas.removeEventListener('wheel',onWheel);card.removeEventListener('click',onCardClick);window.removeEventListener('resize',resize);}, fit, stats:{nodes:nodes.length,edges:structuralLinks.length+pairLinks.length+dependencyLinks.length,prs:graphPrs.length} };
}
async function renderRuns() {
  const runs = await api('/api/runs');
  $('#runs-view').innerHTML = `<div class="summary-note"><span><b>Analysis runs</b> · Reopen completed runs for comparison.</span></div>${runs.map((run) => `<div class="run-row"><span class="dot ${run.status === 'complete' ? 'ready' : run.status === 'running' ? 'running' : 'failed'}"></span><div><b>${esc(run.repo)}</b><div class="run-meta">${esc(run.status)} · ${esc(run.stage)} · ${new Date(run.updatedAt || run.createdAt).toLocaleString('en-US')}</div></div><button class="secondary" data-open-run="${esc(run.id)}">Open</button></div>`).join('')}`;
}
function renderView() {
  document.body.classList.toggle('map-mode', state.view === 'map');
  if (state.view !== 'map') { graphController?.destroy(); graphController = null; }
  $('#queue-view').classList.toggle('hidden', state.view !== 'queue');
  $('#map-view').classList.toggle('hidden', state.view !== 'map');
  $('#runs-view').classList.toggle('hidden', state.view !== 'runs');
  $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  if (state.view === 'queue') renderQueue();
  if (state.view === 'map') renderMap();
  if (state.view === 'runs') void renderRuns();
}
function hierarchy(card) {
  return card.hierarchy.map((row) => `${row.sector} / ${row.domain}${row.subDomain ? ` / ${row.subDomain}` : ''}`);
}
function diffHtml(diff) {
  const patch = diff.patchExcerpt ? esc(diff.patchExcerpt) : 'GitHub did not provide a patch excerpt.';
  return `<details class="diff"><summary>#${diff.pr} · ${esc(diff.path)}${diff.patchTruncated ? ' · truncated' : ''}</summary><pre>${patch}</pre></details>`;
}
function closePairModal() { $('#pair-overlay').classList.add('hidden'); $('#pair-modal').innerHTML = ''; }
async function openPairModal(id) {
  const pair=state.pairs.find((row)=>pairId(row)===id);if(!pair)return;
  state.selected=id;const overlay=$('#pair-overlay'),modal=$('#pair-modal');overlay.classList.remove('hidden');modal.innerHTML='<div class="detail-empty"><p>Loading the review packet…</p></div>';
  try {
    const packet=await api(`/api/runs/${encodeURIComponent(state.runId)}/pairs/${pair.prA}/${pair.prB}`);const verdict=pairVerdict(pair),meta=VERDICTS[verdict],judged=judgments()[id];const hypothesis=packet.candidate.potentialConflicts?.[0]||'The retrieval signals overlap, but the semantic effect still requires review.';
    modal.innerHTML=`<div class="modal-head"><span class="modal-verdict" style="--verdict-color:${meta.color}">${esc(meta.label)}</span><span class="modal-pair">#${packet.prA.pr} × #${packet.prB.pr}</span><span class="modal-score">${esc(packet.candidate.selectionStage)} · score ${packet.candidate.score.toFixed(2)} · ${esc(assessmentType(packet.candidate))}</span><button class="modal-close" data-modal-close aria-label="Close pair assessment">×</button></div>
      <div class="modal-body">
        <section class="modal-callout" style="--verdict-color:${meta.color}"><b>Semantic assessment candidate</b> — ${esc(hypothesis)}<small>${verdict==='unreviewed'?'Evidence-backed retrieval hypothesis; semantic verdict has not been run yet.':`Current browser judgment: ${meta.label}`}</small></section>
        <section class="detail-section"><h3>Pull request faceoff</h3><div class="pr-grid"><div class="pr-card"><span class="side-label">PR A</span><a target="_blank" rel="noreferrer" href="https://github.com/${esc(packet.repo)}/pull/${packet.prA.pr}">#${packet.prA.pr}</a><p>${esc(packet.prA.title)}</p></div><div class="pr-card"><span class="side-label">PR B</span><a target="_blank" rel="noreferrer" href="https://github.com/${esc(packet.repo)}/pull/${packet.prB.pr}">#${packet.prB.pr}</a><p>${esc(packet.prB.title)}</p></div></div></section>
        <section class="detail-section"><h3>Why this pair entered review</h3><div class="signals">${packet.candidate.reasons.slice(0,6).map((reason)=>`<div class="signal"><span>${esc(reason.signal)} · ${esc(reason.detail)}</span><i><b style="width:${Math.min(100,Math.max(4,reason.weight*4))}%"></b></i><em>${reason.weight.toFixed(1)}</em></div>`).join('')}</div></section>
        <section class="detail-section"><h3>Assumption faceoff</h3><div class="assumption-grid"><div><b>PR A · #${packet.prA.pr}</b>${packet.prA.assumptions.map((value)=>`<div class="assumption">${esc(value)}</div>`).join('')||'<div class="assumption">No explicit assumptions extracted</div>'}</div><div><b>PR B · #${packet.prB.pr}</b>${packet.prB.assumptions.map((value)=>`<div class="assumption">${esc(value)}</div>`).join('')||'<div class="assumption">No explicit assumptions extracted</div>'}</div></div></section>
        <section class="detail-section"><h3>Shared concrete resources</h3><div class="chips">${packet.candidate.sharedResources.map((value)=>`<span class="chip strong">${esc(value)}</span>`).join('')||'<span class="assumption">Explicit dependency relationship only</span>'}</div></section>
        <section class="detail-section"><h3>Code spots to verify before merging</h3>${packet.evidence.diffExcerpts.map(diffHtml).join('')||'<div class="assumption">No diff evidence was retrieved.</div>'}</section>
      </div>
      <div class="modal-foot"><p>This is an AI-suggested review candidate. A human makes the final call.</p><button class="modal-judge ${judged==='conflict'?'active':''}" data-modal-judge="conflict" data-value="conflict">Confirm conflict</button><button class="modal-judge ${judged==='uncertain'?'active':''}" data-modal-judge="uncertain" data-value="uncertain">Uncertain</button><button class="modal-judge ${judged==='possible_duplicate'?'active':''}" data-modal-judge="possible_duplicate" data-value="possible_duplicate">Possible duplicate</button><button class="modal-judge ${judged==='harmless'||judged==='no_conflict'?'active':''}" data-modal-judge="harmless" data-value="harmless">Harmless</button></div>`;
  } catch(error) { modal.innerHTML=`<div class="detail-empty"><p>${esc(error.message)}</p><button class="secondary" data-modal-close>Close</button></div>`; }
}
async function openPair(id) {
  state.selected = id; renderQueue();
  const pair = state.pairs.find((row) => pairId(row) === id); if (!pair) return;
  $('#detail-empty').classList.add('hidden'); $('#detail-content').classList.remove('hidden');
  $('#detail-content').innerHTML = '<div class="detail-empty"><p>Loading the review packet…</p></div>';
  try {
    const packet = await api(`/api/runs/${encodeURIComponent(state.runId)}/pairs/${pair.prA}/${pair.prB}`);
    const judged = judgments()[id]; const verdict=pairVerdict(pair); const verdictMeta=VERDICTS[verdict];
    const hypothesis=packet.candidate.potentialConflicts?.[0]||'The retrieval signals overlap, but the semantic effect still requires review.';
    $('#detail-content').innerHTML = `<div class="detail-head"><div><div class="detail-kicker">${esc(packet.candidate.selectionStage)} · SCORE ${packet.candidate.score.toFixed(2)}</div><h2>#${packet.prA.pr} × #${packet.prB.pr}</h2></div><span class="detail-verdict" style="--verdict-color:${verdictMeta.color}">${esc(verdictMeta.label)}</span></div>
      <div class="detail-body">
        <section class="assessment-banner" style="--verdict-color:${verdictMeta.color}"><div class="assessment-banner-top"><span>SEMANTIC ASSESSMENT CANDIDATE</span><b>${esc(assessmentType(packet.candidate))}</b></div><p>${esc(hypothesis)}</p><small>${verdict==='unreviewed'?'Evidence-backed retrieval hypothesis · semantic verdict not run yet':`Current browser judgment · ${esc(verdictMeta.label)}`}</small></section>
        <section class="detail-section"><h3>Pull request faceoff</h3><div class="pr-grid">
          <div class="pr-card"><span class="side-label">PR A</span><a target="_blank" rel="noreferrer" href="https://github.com/${esc(packet.repo)}/pull/${packet.prA.pr}">#${packet.prA.pr}</a><p>${esc(packet.prA.title)}</p></div>
          <div class="pr-card"><span class="side-label">PR B</span><a target="_blank" rel="noreferrer" href="https://github.com/${esc(packet.repo)}/pull/${packet.prB.pr}">#${packet.prB.pr}</a><p>${esc(packet.prB.title)}</p></div></div>
        </section>
        <section class="detail-section"><h3>Ranking signals</h3><div class="signals">${packet.candidate.reasons.slice(0,6).map((reason) => `<div class="signal"><span>${esc(reason.signal)} · ${esc(reason.detail)}</span><i><b style="width:${Math.min(100,Math.max(4,reason.weight*4))}%"></b></i><em>${reason.weight.toFixed(1)}</em></div>`).join('')}</div></section>
        <section class="detail-section"><h3>Hierarchy</h3><div class="chips">${[...hierarchy(packet.prA),...hierarchy(packet.prB)].map((v) => `<span class="chip">${esc(v)}</span>`).join('')}</div></section>
        <section class="detail-section"><h3>Shared concrete resources</h3><div class="chips">${packet.candidate.sharedResources.map((v) => `<span class="chip strong">${esc(v)}</span>`).join('') || '<span class="assumption">Explicit dependency relationship only</span>'}</div></section>
        <section class="detail-section"><h3>Potential conflict to verify</h3>${packet.candidate.potentialConflicts.map((v) => `<div class="hypothesis">${esc(v)}</div>`).join('')}</section>
        <section class="detail-section"><h3>Authored assumption faceoff</h3><div class="assumption-grid"><div><b>PR A · #${packet.prA.pr}</b>${packet.prA.assumptions.map((v) => `<div class="assumption">${esc(v)}</div>`).join('') || '<div class="assumption">No explicit assumptions</div>'}</div><div><b>PR B · #${packet.prB.pr}</b>${packet.prB.assumptions.map((v) => `<div class="assumption">${esc(v)}</div>`).join('') || '<div class="assumption">No explicit assumptions</div>'}</div></div></section>
        <section class="detail-section"><h3>Diff evidence</h3>${packet.evidence.diffExcerpts.map(diffHtml).join('') || '<div class="assumption">No diff evidence</div>'}</section>
        <section class="detail-section human-judgment"><h3>Human judgment</h3><p class="judgment-note">The radar raises a candidate. A human owns the final verdict.</p><div class="judgments four">
          <button class="judge ${judged === 'conflict' ? 'active' : ''}" data-value="conflict">Confirm conflict</button>
          <button class="judge ${judged === 'uncertain' ? 'active' : ''}" data-value="uncertain">Uncertain</button>
          <button class="judge ${judged === 'possible_duplicate' ? 'active' : ''}" data-value="possible_duplicate">Possible duplicate</button>
          <button class="judge ${judged === 'harmless' || judged === 'no_conflict' ? 'active' : ''}" data-value="harmless">Harmless</button>
        </div></section>
      </div>`;
  } catch (error) { $('#detail-content').innerHTML = `<div class="detail-empty"><p>${esc(error.message)}</p></div>`; }
}

async function loadRun(id) {
  window.clearInterval(state.poll); state.runId = id; state.selected = null;
  const run = await api(`/api/runs/${encodeURIComponent(id)}`); status(run); state.summary = run.summary; $('#repo-label').textContent = run.repo; renderFunnel();
  localStorage.setItem('pr-radar-last-run', id);
  if (run.status === 'complete') {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/results`); state.summary = result.summary; state.pairs = result.pairs; state.graph = result.graph || null; renderFunnel(); renderView();
    $('#detail-empty').classList.remove('hidden'); $('#detail-content').classList.add('hidden');
  } else if (run.status === 'running' || run.status === 'queued') {
    state.pairs = []; state.graph = null; renderView(); startPolling(id);
  }
}
function startPolling(id) {
  window.clearInterval(state.poll);
  state.poll = window.setInterval(async () => {
    try {
      const run = await api(`/api/runs/${encodeURIComponent(id)}`); status(run); state.summary = run.summary; renderFunnel();
      if (run.status === 'complete') { window.clearInterval(state.poll); await loadRun(id); toast('Analysis complete.'); }
      if (run.status === 'failed' || run.status === 'cancelled') window.clearInterval(state.poll);
    } catch (error) { toast(error.message); }
  }, 1800);
}

$('#scan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = { repo: $('#repo-input').value, token: $('#token-input').value, pairBudget: Number($('#budget-input').value), maxPrs: $('#max-prs-wrap').classList.contains('hidden') ? undefined : Number($('#max-prs-input').value) };
    const run = await api('/api/runs', { method:'POST', body:JSON.stringify(payload) });
    $('#token-input').value = ''; state.runId = run.id; state.summary = null; state.pairs = []; state.graph = null; localStorage.setItem('pr-radar-last-run',run.id); $('#repo-label').textContent = run.repo; status(run); renderFunnel(); renderView(); startPolling(run.id); toast('Analysis started.');
  } catch (error) { toast(error.message); }
});
$('#advanced-toggle').addEventListener('click', () => $('#max-prs-wrap').classList.toggle('hidden'));
$('#cancel-button').addEventListener('click', async () => { if (state.runId === 'openclaw-current') return; await api(`/api/runs/${encodeURIComponent(state.runId)}/cancel`, {method:'POST',body:'{}'}); toast('Cancellation requested.'); });
$('.viewbar').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-view]'); if (tab) { state.view = tab.dataset.view; $('#content').scrollTop=0; renderView(); }
  const filter = event.target.closest('[data-filter]'); if (filter) { state.filter = filter.dataset.filter; $$('.filter').forEach((b) => b.classList.toggle('active', b === filter)); renderQueue(); }
});
$('#search-input').addEventListener('input', (event) => { state.search = event.target.value.trim(); renderQueue(); });
$('#queue-view').addEventListener('click', (event) => { const row = event.target.closest('[data-pair]'); if (row) void openPair(row.dataset.pair); });
$('#queue-view').addEventListener('keydown', (event) => { const row = event.target.closest('[data-pair]'); if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void openPair(row.dataset.pair); } });
$('#runs-view').addEventListener('click', (event) => { const button = event.target.closest('[data-open-run]'); if (button) void loadRun(button.dataset.openRun); });
$('#detail-content').addEventListener('click', (event) => { const button = event.target.closest('[data-value]'); if (!button || !state.selected) return; saveJudgment(state.selected, button.dataset.value); $$('.judge').forEach((b) => b.classList.toggle('active', b === button)); const meta=VERDICTS[button.dataset.value];const chip=$('.detail-verdict');const banner=$('.assessment-banner');if(chip&&meta){chip.textContent=meta.label;chip.style.setProperty('--verdict-color',meta.color);}if(banner&&meta){banner.style.setProperty('--verdict-color',meta.color);const note=banner.querySelector('small');if(note)note.textContent=`Current browser judgment · ${meta.label}`;}renderQueue(); toast('Judgment saved in this browser.'); });
$('#pair-overlay').addEventListener('click', (event) => { if(event.target===$('#pair-overlay')||event.target.closest('[data-modal-close]')){closePairModal();return;}const button=event.target.closest('[data-modal-judge]');if(!button||!state.selected)return;saveJudgment(state.selected,button.dataset.modalJudge);renderQueue();toast('Judgment saved in this browser.');void openPairModal(state.selected); });
document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!$('#pair-overlay').classList.contains('hidden'))closePairModal();});

async function boot() {
  const saved=localStorage.getItem('pr-radar-last-run');
  if(saved){try{return await loadRun(saved);}catch{/* Fall through to the latest available run. */}}
  const runs=await api('/api/runs');const latest=runs.find((run)=>run.id!=='openclaw-current'&&run.status==='complete')||runs[0];
  return loadRun(latest?.id||'openclaw-current');
}
boot().catch((error) => { status({status:'failed',stage:'Failed to load results',progress:0,logs:[error.message]}); toast(error.message); });
