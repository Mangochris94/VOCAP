/* ════════════════════════════════════════════════════════════════
   VOCAP ENGINE

   Shared by both games. Nothing in here decides which language is being
   played: that comes from window.VOCAP_CONFIG, set by whichever page loaded
   this file. Keeping one engine means a fix or a feature lands in both games
   at once, which matters more than it sounds - the alternative is two copies
   drifting apart within a fortnight.

   Config keys, all set before this script runs:
     game      'en' | 'th'   which game this page is
     data      path to the word file
     dict      path to the dictionary, or null for none
     trayStart / trayMax     tray growth range
   ════════════════════════════════════════════════════════════════ */

const CFG = window.VOCAP_CONFIG || {game:'en', data:'words.json', dict:'dictionary.json'};

/* =====================================================================
   VOCAP M1 — direct port of drop_engine.py (the tuned reference).
   Letters are NOT consumed. The tray is mined, not spent.
   Growing tray: 8 slots + 1 per 2 completed sub-lists, max 15.
   ===================================================================== */

const POOL_START=8, POOL_CAP=15, MIN_NOISE=1, HF='High-Frequency / Core', HF_COOLDOWN=3;
/* Tray growth by PROGRESS, not completion. Escalating thresholds: the first
   upgrade lands inside a single session (so the mechanic teaches itself), the
   last sits around 400 words (so max tray is a genuine mid-game milestone).
   Counts CURATED discoveries only - dictionary words don't grow the tray. */
const GROWTH=[15,50,110,200,330,520,780];  // cumulative curated words for slots 9..15
/* Rescaled when the collection grew from 966 to ~1,930 words. The old curve
   (10..400) was tuned for the smaller set and maxed the tray at 21% of the
   collection - far too fast. This puts max tray back around 40%, while the
   first upgrade still lands inside the first session so the mechanic keeps
   teaching itself. */

let INTERVAL_MS = 5*60*1000;       // player-chosen: 5 / 10 / 20 minutes
const FAST_MS     = 2*1000;         // debug fast mode: a workday in minutes
// English letter frequencies for noise letters (same table as the Python)
const FREQ_ACTIVE={};
let GROWTH_BASE = CFG.trayStart || 8, MAXTRAY = CFG.trayMax || 15;
const FREQ={e:12.5,t:9.3,a:8.0,o:7.6,i:7.7,n:7.2,s:6.5,r:6.3,h:5.1,l:4.1,d:3.8,
c:3.3,u:2.8,m:2.5,f:2.4,p:2.1,g:1.9,w:1.7,y:1.6,b:1.5,v:1.0,k:0.6,x:0.2,j:0.1,q:0.1,z:0.1};
/* Filling a tray with noise needs to know which characters exist in this
   game. Deriving that from the loaded word file rather than a hardcoded table
   is the only way a foreign letter can never appear: after the engine was
   split out, Thai trays were still being padded from the English table. */
function deriveFreq(bank){
  const f={};
  for(const w of bank) for(const ch of w.spell){
    if(ch===' ') continue;
    f[ch]=(f[ch]||0)+1;
  }
  const tot=Object.values(f).reduce((a,b)=>a+b,0)||1;
  for(const k in f) f[k]=f[k]/tot*100;
  return f;
}

const LATIN_VOWELS=new Set('aeiou');
/* Whichever script the game is running. THAI_VOWELS is defined further down
   with the rest of the Thai handling. */
function isVowel(c){ return GAME==='th' ? THAI_VOWELS.has(c) : LATIN_VOWELS.has(c); }
// Everyday flavour (default). Explorer/Scholar arrive with the settings screen.
const PLAN=[[3,5],[3,6],[4,7]];

let BANK=[], seen=new Set(), sparks=0, cycleNo=0;
/* Unsolved clues go on COOLDOWN rather than returning next run. Seeing the
   same unsolved word immediately again is demoralising - it reads as the game
   nagging. After a few runs away it reads as a familiar face instead. */
let snoozed={};                  // word id -> earliest cycle it may return
const SNOOZE_MIN=3, SNOOZE_MAX=6;
let DICT=new Set();              // bundled common-English list (validity + Dictionary reveals)
let DEFS={};                     // WordNet glosses for dictionary words
let inked=new Set();             // dictionary words the player has revealed
let inkTally={};                 // word -> times formed; drives promotion (design 5.4)
/* Hints cost a share of what the word pays, so one is worth buying and three
   is a clear loss. Prices are 0.5x, 1.0x and 1.5x the word's base value. */
/* Levels 1-3 chip away at the word. Level 4 hands it over completely and is
   priced at 3x the payout, so solving this way always loses sparks overall. */
const HINT_MULT=[0.5,1.0,1.5,3.0];
let hintsBought={};              // word id -> how many hints taken this cycle
let starterDay=0, lastGift=null; // Starter Pack: one 2-letter gift word per day
let lastTray=POOL_START;         // for announcing upgrades
let pool=[], order=[], dropped=0, seeds=[], repeatPaid=new Set(), timerId=null, nextDrop=0;
let fast=false;
/* The learning-language layer. Persisted, because it defaulted to on and so
   came back every reload no matter how often it was switched off. */
let lang = localStorage.getItem('vocap-learn') || 'th';
/* `lang` is the learning-language switch. On TH the card carries the Thai
   layer as well as the English; on EN the player gets an English-only game,
   which is what an advanced learner wants. */
/* ---- Pause system ----
   Vocap is meant to run while you work, so an unfocused window must NOT
   pause. What should pause is the machine being away: asleep, shut, or the
   tab frozen. We detect that by watching for a jump in the wall clock.

   The threshold scales with the interval rather than being a fixed number of
   minutes: missing three drops means the same thing whether they are five
   minutes apart or twenty. */
const IDLE_INTERVALS = 3;
let lastTick = Date.now();
let awaySince = null;
let burstLeft = 0;               // welcome-back: next drops come quickly
let shownCard = null;            // {w,gain} or {word} - lets a language switch redraw
let shownPop  = null;
let lastActivity = Date.now();   // last time the player actually did something
let holding = false;             // tray is full and waiting for the player
/* `building` is the word tray: each entry is a letter taken from a pool slot,
   or a free space. The pool letter is never removed — it just highlights. */
let building=[];                       // [{ch:'m', from:3} | {ch:' ', from:null}]
const typedWord = () => building.map(b=>b.ch).join('');

const $=id=>document.getElementById(id);
/* Player-chosen strings (race names, equipped titles) travel over PeerJS to
   other people's screens and get built into innerHTML there. Escape them at
   the point of render so a hostile name/title can't inject markup or scripts
   into an opponent's client. */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SAVEKEY = ()=> GAME==='th' ? 'vocap-th' : 'vocap';
/* Every save is a candidate leaderboard update, but a discovery streak can
   call save() many times a minute - submitClassicScore() throttles itself,
   this just decides when it's worth asking. */
let lastLbSubmit=0;
const save=()=>{
  localStorage.setItem(SAVEKEY(),JSON.stringify({seen:[...seen],sparks,inked:[...inked],inkTally,starterDay,lastGift,snoozed,cycleNo}));
  const now=Date.now();
  if(now-lastLbSubmit>15000){ lastLbSubmit=now; submitClassicScore(); }
};
const load=()=>{try{const d=JSON.parse(localStorage.getItem(SAVEKEY()));
  if(d){seen=new Set(d.seen);sparks=d.sparks;
        inked=new Set(d.inked||[]);inkTally=d.inkTally||{};starterDay=d.starterDay||0;lastGift=d.lastGift||null;
        snoozed=d.snoozed||{};cycleNo=d.cycleNo||0;}
  }catch(e){}};

/* ---- speech: browser-native, no audio files needed ----
   Pronunciation is the one thing a text game can't teach, so discovered
   words are spoken by default. Letter-by-letter is opt-in: useful when
   learning, grating in fast mode. */
let sayWords=true, sayLetters=false, voiceEN=null, voiceTH=null;
/* Voice quality varies wildly by device - this just picks the best of
   whatever the browser happens to offer. "Online"/"natural"/"neural" names
   are the higher-quality cloud/neural voices modern browsers expose
   alongside the older, flatter-sounding local ones. */
function pickVoice(){
  const vs=speechSynthesis.getVoices();
  voiceEN = vs.find(v=>/^en-(GB|US)/.test(v.lang)&&/natural|neural|online|premium|enhanced|google|samantha|daniel/i.test(v.name))
         || vs.find(v=>v.lang.startsWith('en')) || null;
  /* Thai voices are far less universal than English ones - many desktop
     browsers simply have none installed. hasThaiVoice() lets the Listening
     mode notice that and say so, rather than play mangled audio. */
  voiceTH = vs.find(v=>v.lang.startsWith('th')) || null;
}
if('speechSynthesis' in window){ pickVoice(); speechSynthesis.onvoiceschanged=pickVoice; }
/* getVoices() can still be empty this early if the browser hasn't fired
   voiceschanged yet - a cheap re-check here closes most of that race
   without needing a retry loop. */
function hasThaiVoice(){ if(!voiceTH && 'speechSynthesis' in window) pickVoice(); return !!voiceTH; }
function speak(text,{rate=0.85,pitch=1,lang='en'}={}){
  if(!('speechSynthesis' in window)) return;
  const u=new SpeechSynthesisUtterance(text);
  /* Tagging the utterance th-TH even with no matching voice object still
     lets the browser reach for its own closest/default voice for that
     language, rather than always falling back to reading Thai text in
     the English voice - which is the actual mangled-audio bug this is
     here to avoid. */
  if(lang==='th'){ u.lang='th-TH'; if(voiceTH) u.voice=voiceTH; }
  else { u.lang='en-GB'; if(voiceEN) u.voice=voiceEN; }
  u.rate=rate; u.pitch=pitch; u.volume=1;
  speechSynthesis.speak(u);
}
function speakLetter(ch){
  if(!sayLetters||ch===' ') return;
  speechSynthesis.cancel();               // keep up with fast tapping
  speak(ch.toUpperCase(),{rate:0.8});
}
function speakWord(w){
  if(!sayWords) return;
  speechSynthesis.cancel();
  speak(w,{rate:0.8});                    // clear and unhurried: this is the teaching moment
}
/* speak() defaults to English. On the Thai page a curated entry's own
   .word is Thai text, which needs the Thai voice (see speakThaiWord) - so
   this always resolves to the English side (the translation on the Thai
   page, the word itself on the English page) before handing it to speak(). */
function englishOf(w){ return GAME==='th' ? (w.translations?.en?.word||'') : w.word; }
function speakEntry(w){ const e=englishOf(w); if(e) speakWord(e); }
/* Listening mode's whole mechanic is "hear the target word, then spell
   it" - playing the English translation there would defeat the point, so
   this is the one place that actually speaks Thai text. Normally that
   only happens with a real Thai voice available; force:true is the
   player's own "play anyway" choice on a device with none, made
   explicitly rather than assumed for them. */
function speakThaiWord(w, force){
  if(!hasThaiVoice() && !force) return;
  speechSynthesis.cancel();
  speak(w,{rate:0.78,lang:'th'});
}

function sparksFor(n){return n<=5?10:n<=8?25:n<=12?60:150}
function count(s){
  /* Tone marks now count the same as any other letter - they have to
     turn up in the tray and get tapped/typed in like everything else. */
  const c={};
  for(const ch of s){
    if(ch===' ') continue;
    c[ch]=(c[ch]||0)+1;
  }
  return c;
}
function canSpell(need,poolC){for(const k in need)if((poolC[k]||0)<need[k])return false;return true}
function union(a,b){const o={...a};for(const k in b)o[k]=Math.max(o[k]||0,b[k]);return o}
function poolCount(){const c={};for(const ch of pool)c[ch]=(c[ch]||0)+1;return c}

/* Only CURATED discoveries grow the tray. Dictionary words pay sparks and
   ink a page, but they're the easy path - letting them buy tray upgrades
   would make the collection feel cheap. */
function progressCount(){ return seen.size }
function traySize(){
  /* Thai starts wider and ends wider. With 61 tile characters rather than 26,
     a tray of eight leaves almost nothing spellable. */
  let n = GAME==='th' ? GROWTH_BASE : POOL_START;
  const cap = GAME==='th' ? MAXTRAY : POOL_CAP;
  for(const t of GROWTH) if(progressCount()>=t) n++;
  return Math.min(cap,n);
}
function nextGrowthAt(){
  for(const t of GROWTH) if(progressCount()<t) return t;
  return null;
}
/* announce an upgrade the moment it is earned */
function checkGrowth(){
  const size=traySize();
  if(size>lastTray){
    lastTray=size;
    flash(`🌱 tray grew to ${size} slots!`,'good');
  }
  const nxt=nextGrowthAt();
  $('traysize').textContent = nxt ? `${size} (next at ${nxt})` : `${size} MAX`;
}

/* ---- seed picking: adaptive bands + HF cooldown (drop_engine.py port) ---- */
function pickSeeds(size){
  const budget=size-MIN_NOISE, allowHF=(cycleNo%HF_COOLDOWN===0);
  const chosen=[]; let acc={};
  const ready = w => !(snoozed[w.id] && cycleNo < snoozed[w.id]);
  const bands=[...PLAN].sort((a,b)=>b[1]-a[1]);
  for(const [lo0,hi0] of bands){
    if(chosen.length>=3)break;
    let cands=[];
    for(let g=0;g<13 && !cands.length;g++){          // adaptive widening
      const lo=Math.max(3,lo0-g), hi=Math.min(15,hi0+g);
      cands=BANK.filter(w=>!seen.has(w.id)&&!chosen.includes(w)&&ready(w)
        &&w.letters>=lo&&w.letters<=hi&&(allowHF||w.topic!==HF));
    }
    // Late game safety: if everything undiscovered is still snoozed, ignore
    // the cooldown rather than leave the run without seeds.
    if(!cands.length){
      cands=BANK.filter(w=>!seen.has(w.id)&&!chosen.includes(w));
    }
    cands.sort(()=>Math.random()-.5);
    for(const w of cands.slice(0,80)){
      const trial=union(acc,count(w.spell));
      if(Object.values(trial).reduce((a,b)=>a+b,0)<=budget){chosen.push(w);acc=trial;break}
    }
  }
  return [chosen,acc];
}

function noiseLetters(acc,n){
  const out=[], ls=Object.keys(FREQ);
  for(let i=0;i<n;i++){
    const cur={...acc}; for(const ch of out)cur[ch]=(cur[ch]||0)+1;
    const tot=Object.values(cur).reduce((a,b)=>a+b,0)||1;
    const vr=Object.entries(cur).filter(([k])=>isVowel(k)).reduce((a,[,v])=>a+v,0)/tot;
    const ws=ls.map(l=>FREQ[l]*(vr<0.32&&isVowel(l)?4:1));
    let r=Math.random()*ws.reduce((a,b)=>a+b,0);
    for(let j=0;j<ls.length;j++){r-=ws[j];if(r<=0){out.push(ls[j]);break}}
  }
  return out;
}

/* shortest seed's letters first so something is formable early */
function buildOrder(size){
  const sorted=[...seeds].sort((a,b)=>a.letters-b.letters);
  let ord=[], built={};
  for(const w of sorted){
    const need=count(w.spell), chunk=[];
    for(const k in need)for(let i=(built[k]||0);i<need[k];i++)chunk.push(k);
    chunk.sort(()=>Math.random()-.5); ord=ord.concat(chunk); built=union(built,need);
  }
  ord=ord.concat(noiseLetters(built,Math.max(MIN_NOISE,size-ord.length)));
  const head=sorted.length?Math.min(sorted[0].letters,ord.length):0;
  const tail=ord.slice(head).sort(()=>Math.random()-.5);
  return ord.slice(0,head).concat(tail).slice(0,size);
}

/* Park every unsolved seed for 3-6 runs before it may be chosen again. */
function snoozeUnsolved(){
  for(const w of seeds){
    if(seen.has(w.id)){ delete snoozed[w.id]; continue }
    const wait=SNOOZE_MIN+Math.floor(Math.random()*(SNOOZE_MAX-SNOOZE_MIN+1));
    snoozed[w.id]=cycleNo+wait;
  }
}

/* ---------------- cycle control ---------------- */
/* The tray fills immediately rather than dripping one letter every 5/10/20
   minutes - that trickle made sense as the whole game, but not as a wait
   between rounds. The drip machinery (dropLetter/scheduleDrop/INTERVAL_MS)
   is left in place rather than deleted: it is exactly what an idle-game
   version of Vocap would want back, sitting in the corner of the screen. */
function startCycle(){
  cycleNo++; const size=traySize();
  [seeds,]=pickSeeds(size); order=buildOrder(size);
  pool=[...order]; dropped=order.length; repeatPaid=new Set(); building=[]; hintsBought={}; holding=false;
  checkGrowth();
  renderTray(); renderWordTray(); renderClue(); scheduleDrop();
}
function dropDelay(){
  if(fast) return FAST_MS;
  if(burstLeft>0) return 60*1000;          // one minute, to make returning feel alive
  return INTERVAL_MS;
}

function scheduleDrop(){
  clearTimeout(timerId);
  const ms=dropDelay(); nextDrop=Date.now()+ms;
  timerId=setTimeout(dropLetter,ms); tickTimer();
}
/* Runs every second. A gap far larger than one second means the machine was
   not running, so we push the timer forward by exactly the missing time
   instead of letting it expire while nobody was watching. */
function watchClock(){
  const now=Date.now(), gap=now-lastTick;
  const threshold=Math.max(30000, dropDelay()*IDLE_INTERVALS);
  if(gap>threshold){
    nextDrop += gap;                       // credit the whole absence back
    awaySince = gap;
    if(gap > 2*60*60*1000) burstLeft = 2;  // away over two hours
    const mins=Math.round(gap/60000);
    flash(mins>=60 ? `welcome back — paused for ${Math.round(mins/60)}h`
                   : `welcome back — paused for ${mins} min`, '');
  }
  lastTick=now;
  setTimeout(watchClock,1000);
}
watchClock();

function tickTimer(){
  const s=Math.max(0,Math.ceil((nextDrop-Date.now())/1000));
  if(holding){ $('timer').textContent=t('waitingYou'); setTimeout(tickTimer,500); return; }
  $('timer').textContent=dropped>=order.length?t('lastCall'):`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  if(dropped<=order.length)setTimeout(tickTimer,500);
}
function dropLetter(){
  if(dropped<order.length){
    pool.push(order[dropped]); dropped++;
    if(burstLeft>0) burstLeft--;
    renderTray(); renderWordTray(); renderClue(); scheduleDrop();
  }else{
    /* Last Call. The design promise is that the tray never resets while nobody
       is watching, so if the player has not touched anything since it filled,
       hold here indefinitely. They get the full tray when they come back. */
    if(Date.now()-lastActivity > dropDelay()){
      holding=true;
      $('timer').textContent=t('waitingYou');
      flash('tray is full and waiting — it will not reset until you play','');
      return;
    }
    sparks+=pool.length;
    snoozeUnsolved();
    save(); startCycle();
  }
}

/* ---------------- rendering ---------------- */
function renderTray(){
  const size=order.length||traySize(); const box=$('tray'); box.innerHTML='';
  const used=highlightMap();
  for(let i=0;i<size;i++){
    const d=document.createElement('div');
    d.className='slot '+(i<pool.length?'filled':'empty');
    if(i<pool.length){
      d.textContent=tileGlyph(pool[i]);
      if(used.has(i))d.classList.add('used');
      d.onclick=()=>{ dropFocus(); noteActivity(); if(!used.has(i)){speakLetter(pool[i]);building.push({ch:pool[i],from:i});renderTray();renderWordTray()} };
    }
    box.appendChild(d);
  }
  $('sparks').textContent=sparks;

  $('foundcount').textContent=seen.size;
  $('inkcount').textContent=inked.size;
}
/* which pool boxes are currently in use down in the word tray */
function highlightMap(){
  return new Set(building.filter(b=>b.from!==null && b.from>=0).map(b=>b.from));
}

/* claim the first unused pool slot holding this letter; null if none free */
function claimSlot(ch){
  const used=highlightMap();
  for(let i=0;i<pool.length;i++) if(pool[i]===ch && !used.has(i)) return i;
  return null;
}


/* Thai marks that attach to a letter: vowels written above or below, and the
   tone marks. Shown on a tile they need a carrier, and the dotted circle is
   the convention every Thai dictionary and keyboard uses. */
const COMBINING = new Set([
  '\u0E31','\u0E34','\u0E35','\u0E36','\u0E37','\u0E38','\u0E39','\u0E3A',
  '\u0E47','\u0E48','\u0E49','\u0E4A','\u0E4B','\u0E4C','\u0E4D','\u0E4E'
]);
function tileGlyph(ch){ return COMBINING.has(ch) ? '\u25CC'+ch : ch; }

function renderWordTray(){
  /* Named `box`, not `t` — `t` is the translation function, and shadowing it
     here made every render throw. */
  const box=$('wordtray'); if(!box) return;
  const sb=$('submit'); if(sb) sb.disabled = building.length===0;
  const s=building.map(b=>b.ch).join('');
  if(GAME==='th'){
    /* Let the font do the stacking. Laying Thai out as separate tiles put
       vowels and tone marks beside the letter they belong on, which is simply
       the wrong word. A text run renders it the way Thai is actually written. */
    box.className='wordtray thai';
    box.innerHTML = s
      ? `<span class="thword">${s}</span>`
      : `<span class="hintline">${t('tapAbove')}</span>`;
    return;
  }
  box.className='wordtray';
  box.innerHTML = building.length
    ? building.map(b=>`<div class="slot filled">${b.ch}</div>`).join('')
    : `<span class="hintline">${t('tapAbove')}</span>`;
}

function hintCost(w,level){ return Math.max(1, Math.round(sparksFor(w.letters)*HINT_MULT[level])); }

/* Level 1: first letter. 2: every vowel placed. 3: one more consonant.
   4: the whole word, priced so that solving this way always loses sparks. */
function hintMask(w,level){
  const s=w.spell, out=[];
  let extra=-1;
  for(let i=s.length-1;i>0;i--) if(!isVowel(s[i])){ extra=i; break; }
  for(let i=0;i<s.length;i++){
    const c=s[i];
    const show = level>=4 || (level>=1 && i===0)
              || (level>=2 && isVowel(c)) || (level>=3 && i===extra);
    out.push(show?c:'_');
  }
  return out.join(' ');
}

function buyHint(id){
  const w=BANK.find(x=>x.id===id); if(!w) return;
  const have=hintsBought[id]||0;
  if(have>=4){flash('the whole word is already showing','');return}
  const cost=hintCost(w,have);
  if(sparks<cost){flash(`need ${cost} sparks for that hint`,'bad');return}
  sparks-=cost; hintsBought[id]=have+1; save();
  flash(have===3 ? `word revealed · -${cost} ✨` : `hint bought · -${cost} ✨`,'');
  renderTray(); renderClue();
}

function renderClue(){
  const active=seeds.filter(w=>!seen.has(w.id));
  const el=$('clue');
  if(!active.length){el.textContent='';return}
  const pc=poolCount();
  el.innerHTML=active.map(w=>{
    /* On TH the player sees both, exactly as they do in a race: the English
       is what they are hunting, the Thai is the way in. On EN it is English
       only, which is the harder game an advanced learner wants. */
    const th = (GAME!=='th' && lang==='th') ? (w.translations?.th?.definition || '') : '';
    const desc = w.definition;
    const ok=canSpell(count(w.spell),pc);
    const lv=hintsBought[w.id]||0;
    const shown = lv>0 ? `<div class="reveal">${hintMask(w,lv)}</div>` : '';
    let next;
    if(lv>=4)      next=`<button disabled>revealed</button>`;
    else if(lv===3) next=`<button class="solve" onclick="buyHint('${w.id}')" `
                        + `${sparks<hintCost(w,lv)?'disabled':''}>🔓 reveal · ${hintCost(w,lv)}✨</button>`;
    else            next=`<button onclick="buyHint('${w.id}')" `
                        + `${sparks<hintCost(w,lv)?'disabled':''}>💡 ${hintCost(w,lv)}✨</button>`;
    return `<div class="clueline"><span class="${ok?'spellable':''}">🔎 ${desc}</span>`
         + `<span class="hintbar">${next}</span>`
         + (th?`<div class="cl-th2">${th}</div>`:'')
         + `<div class="cl-n2">${w.letters} letters</div>${shown}</div>`;
  }).join('');
  el.className=active.some(w=>canSpell(count(w.spell),poolCount()))?'spellable':'';
}

/* ---------------- word submission ---------------- */
function submit(){
  const raw=typedWord().trim().toLowerCase();
  building=[]; renderWordTray();
  const plain=raw.replace(/ /g,'');
  const pc=poolCount();

  if(plain.length<3){flash('too short','bad');renderTray();return}

  /* ---- ONE guard for everything: a word pays at most once per run ----
     Previously each reward branch tracked its own state, so resubmitting a
     word could fall through to a different branch and pay again. Now every
     credited word - curated or dictionary - lands in repeatPaid, and this
     check runs before any reward is considered. */
  if(repeatPaid.has(plain)){
    flash('already used this run','');
    renderTray(); return;
  }

  const w=BANK.find(x=>x.spell===plain||x.word===raw);

  /* ---------- curated word ---------- */
  if(w){
    if(!canSpell(count(w.spell),pc)){flash('letters not in the tray','bad');renderTray();return}
    repeatPaid.add(plain);
    if(seen.has(w.id)){                       // found on an earlier run
      sparks++; save(); speakEntry(w);
      flash('already in your collection · +1 ✨','good');
      renderTray(); renderClue(); return;
    }
    const fresh=1+(order.length-dropped)/8;   // freshness bonus (design 4.4)
    const gain=Math.round(sparksFor(w.letters)*fresh);
    sparks+=gain; seen.add(w.id); save();
    speakEntry(w); showCard(w,gain); logWord(w);
    flash(`+${gain} ✨`,'good');
    renderTray(); renderClue(); checkGrowth();
    return;
  }

  /* ---------- dictionary word ---------- */
  if(DICT.has(plain)){
    if(!canSpell(count(plain),pc)){flash('letters not in the tray','bad');renderTray();return}
    repeatPaid.add(plain);
    inkTally[plain]=(inkTally[plain]||0)+1;
    if(inked.has(plain)){                     // inked on an earlier run
      sparks++; save(); flash('already inked · +1 ✨','good');
      renderTray(); renderClue(); return;
    }
    inked.add(plain); sparks+=2; save();
    speakWord(plain); showDictCard(plain);
    const before=Math.floor((inked.size-1)/100), after=Math.floor(inked.size/100);
    if(after>before){sparks+=100;flash(`📖 ${inked.size} words inked · +100 ✨ milestone!`,'good')}
    else flash('📖 inked in the Dictionary · +2 ✨','good');
    renderTray(); renderClue(); return;
  }

  flash('not an English word','bad');
  renderTray();
}

/* One card, several moods. The tier controls how much the card announces
   itself: a three-letter word should feel like a tick, a fourteen-letter one
   like an event. Everything else stays identical so the layout is learnable. */
const TOPIC_ICON={
 'Animals':'🐾','Fruits':'🍎','Vegetables':'🥕','Food & Drink':'🍜','Thai Food & Cooking':'🌶️',
 'Body Parts':'🖐️','Health & Body':'🩺','Family & People':'👪','Emotions & Feelings':'💭',
 'Colors & Shapes':'🎨','Clothes & Fashion':'👕','House & Home':'🏠','Kitchen & Utensils':'🍳',
 'Buildings & Structures':'🏛️','Tools & DIY':'🔧','Containers & Materials':'📦',
 'Nature & Weather':'🌦️','Flowers & Plants':'🌸','Ocean & Beach':'🌊','Sky & Space':'🪐',
 'Science Basics':'🔬','Technology':'💻','Transportation':'🚌','Travel & Places':'🧭',
 'Directions & Position':'🧭','Time & Calendar':'🕰️','Numbers & Measurement':'📏',
 'Education':'📚','Jobs & Work':'💼','Money & Shopping':'🏷️','Restaurant & Ordering':'🍽️',
 'Sports & Games':'⚽','Music & Instruments':'🎵','Art & Crafts':'🎨',
 'Media & Entertainment':'🎬','Celebrations & Festivals':'🎉','Slang & GenZ':'💬',
 'High-Frequency / Core':'⭐','Describing Words':'✨','Actions & Movement':'🏃'};

function tierFor(n){ return n<=5?1 : n<=8?2 : n<=12?3 : 4; }

/* Both the main card and the in-menu popup are built from this, so a word
   looks identical wherever you meet it. */
function cardHTML(w,gain){
  /* English game: the Thai layer is optional and follows the + ไทย button.
     Thai game: the English translation is always shown, because it is the
     only thing the card can teach and there is nothing to switch off. */
  const th = GAME==='th' ? (w.translations?.en||{})
                         : (lang==='th' ? (w.translations?.th||{}) : {});
  const tags=[w.topic,w.topic2].filter(Boolean)
      .map(t=>`<span>${TOPIC_ICON[t]||'✦'} ${t}</span>`).join('');
  return `
    <div id="c-art">${TOPIC_ICON[w.topic]||'✦'}</div>
    <div id="c-body">
      <div id="c-head">
        <h2 id="c-word">${w.word}</h2>
        <button id="c-speak" class="speakbtn" title="listen">🔊</button>
        <span id="c-pos">${w.letters} letters</span>
        <span id="c-spark">${gain?`+${gain} ✨`:'in your collection'}</span>
      </div>
      <div class="th">${th.word||''}</div>
      <p>${w.definition}</p>
      <p id="c-thdef">${th.definition||''}</p>
      <div id="c-factbox"><p>${w.history||''}</p><p>${th.history||''}</p></div>
      <p id="c-sent">${w.sentence?'\u201c'+w.sentence+'\u201d':''}</p>
      <div id="c-tags">${tags}</div>
    </div>`;
}

function dictCardHTML(word){
  const g=DEFS[word];
  const senses=Array.isArray(g)?g:(g?[g]:[]);
  const list=senses.length
    ? senses.map((s,i)=>`<p>${i+1}. ${s}</p>`).join('')
    : '<p>(no definition available)</p>';
  return `
    <div id="c-art">📖</div>
    <div id="c-body">
      <div id="c-head">
        <h2 id="c-word">${word}</h2>
        <button id="c-speak" class="speakbtn" title="listen">🔊</button>
        <span id="c-pos">${word.length} letters</span>
      </div>
      ${list}
      <div id="c-tags"><span>📖 Dictionary word</span></div>
      <div id="lookup"><a href="#" onclick="openExternal('https://dict.longdo.com/search/${encodeURIComponent(word)}');return false">ดูคำแปลไทย · look up in Thai ↗</a></div>
    </div>`;
}

function showCard(w,gain){
  shownCard={w,gain};
  $('card').innerHTML = cardHTML(w,gain) + '<button id="c-close" title="close">×</button>';
  $('card').className = 'show tier'+tierFor(w.letters);
  bindCard(w);
}

/* Dictionary card — deliberately plainer than a discovery card. The curated
   966 get history, Thai and (later) art; dictionary words get a definition
   and a page. The gap between them is what makes the collection feel special. */
function showDictCard(word){
  shownCard={word};
  $('card').innerHTML = dictCardHTML(word) + '<button id="c-close" title="close">×</button>';
  $('card').className='show dict';
  bindCard(null,word);
}

/* wire the close button and the speaker button. A dictionary word (plainWord)
   is always plain English already; a curated word goes through englishOf()
   since w.word is Thai text on the Thai page and speak() only knows English. */
function bindCard(w,plainWord){
  const c=$('c-close'); if(c) c.onclick=()=>{ $('card').className=''; shownCard=null; };
  const s=$('c-speak');
  if(s) s.onclick=()=>{ speechSynthesis.cancel(); speak(w?englishOf(w):plainWord,{rate:0.8}); };
}

function logWord(w){$('log').innerHTML+=`<span>${w.word}</span>`}
function flash(t,c){$('msg').textContent=t;$('msg').className=c||''}

/* ═══════════════ Collection & Dictionary browsers ═══════════════
   The tray is where you play; these are where the collection lives. Topic
   screens show undiscovered words as silhouettes with their letter count -
   the design's "tease, don't hide" rule: a blank slot invites a hunt, a
   hidden list invites nothing. */

/* Stop a previously clicked button from stealing the Enter key. */
function noteActivity(){ lastActivity=Date.now(); if(holding){ holding=false; scheduleDrop(); } }

function dropFocus(){ if(document.activeElement && document.activeElement.blur) document.activeElement.blur(); }

function openPanel(html){ $('panel').innerHTML=html; $('overlay').className='show'; }
function closePanel(){ $('overlay').className=''; }
$('overlay') && ($('overlay').onclick=e=>{ if(e.target.id==='overlay') closePanel() });

function topicStats(){
  const m={};
  for(const w of BANK_ALL){
    for(const t of [w.topic, w.topic2]){
      if(!t) continue;
      (m[t]=m[t]||{total:0,found:0,words:[]});
      m[t].total++; m[t].words.push(w);
      if(seen.has(w.id)) m[t].found++;
    }
  }
  return m;
}

function showCollection(){
  const m=topicStats();
  const names=Object.keys(m).sort((a,b)=>m[b].found-m[a].found||a.localeCompare(b));
  const rows=names.map(t=>{
    const s=m[t], pct=Math.round(s.found/s.total*100);
    const started=s.found>0;
    return `<div class="trow ${s.found===s.total?'done':''}" onclick="showTopic('${t.replace(/'/g,"\\'")}')">
      <span class="nm">${started?t:'? ? ?'}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="ct">${s.found}/${s.total}</span></div>`;
  }).join('');
  const tot=seen.size, all=BANK_ALL.length;
  openPanel(`<div class="phead"><div><h2>Collection</h2>
      <div class="sub">${tot} of ${all} words found · ${Math.round(tot/all*100)}%</div></div>
      <button onclick="closePanel()">close</button></div>${rows}`);
}

function showTopic(t){
  const m=topicStats()[t];
  if(!m) return;
  const bySub={};
  for(const w of m.words) (bySub[w.sublist]=bySub[w.sublist]||[]).push(w);
  let html='';
  for(const sub of Object.keys(bySub).sort()){
    const ws=bySub[sub].sort((a,b)=>a.letters-b.letters||a.word.localeCompare(b.word));
    const f=ws.filter(w=>seen.has(w.id)).length;
    html+=`<div class="sub-h">${sub} — ${f}/${ws.length}</div><div class="wgrid">`;
    html+=ws.map(w=>seen.has(w.id)
      ? `<span class="wchip" onclick="replay('${w.id}')">${w.word}</span>`
      : `<span class="wchip hidden">${'_'.repeat(w.letters)}</span>`).join('');
    html+='</div>';
  }
  openPanel(`<button class="back" onclick="showCollection()">← all topics</button>
    <div class="phead"><div><h2>${t}</h2>
    <div class="sub">${m.found} of ${m.total} found</div></div>
    <button onclick="closePanel()">close</button></div>${html}`);
}

/* A link in a Tauri window does not navigate anywhere by itself, so ask the
   OS to open it. In a browser this is just window.open. */
function openExternal(url){
  const o = window.__TAURI__ && (window.__TAURI__.opener || window.__TAURI__.shell);
  if(o && o.openUrl)      { o.openUrl(url); return; }
  if(o && o.open)         { o.open(url);    return; }
  window.open(url, '_blank', 'noopener');
}

function openPop(html,extraClass){
  $('popcard').className = extraClass||'';
  $('popcard').innerHTML = html + '<button id="c-close" title="close">×</button>';
  $('popup').className='show';
  const c=$('c-close'); if(c) c.onclick=closePop;
}
function closePop(){ $('popup').className=''; shownPop=null; }
$('popup') && ($('popup').onclick=e=>{ if(e.target.id==='popup') closePop(); });

/* Opening a word from the collection keeps you inside the collection.
   Queried scoped to #popcard, not $('c-speak') - #card can already hold a
   stale copy of the same id from an earlier discovery, and a plain
   getElementById would silently bind the popup's button to that one. */
function replay(id){
  const w=BANK_ALL.find(x=>x.id===id); if(!w) return;
  shownPop={w};
  openPop(cardHTML(w,0));
  const s=document.querySelector('#popcard #c-speak');
  if(s) s.onclick=()=>{ speechSynthesis.cancel(); speak(englishOf(w),{rate:0.8}); };
  speakEntry(w);
}
function peekDict(word){
  shownPop={word};
  openPop(dictCardHTML(word),'dict');
  const s=document.querySelector('#popcard #c-speak');
  if(s) s.onclick=()=>{speechSynthesis.cancel();speak(word,{rate:0.8})};
}

function showDictionary(){
  const letters='abcdefghijklmnopqrstuvwxyz'.split('');
  const byL={};
  for(const w of inked) (byL[w[0]]=byL[w[0]]||[]).push(w);
  const shelf=letters.map(L=>{
    const n=(byL[L]||[]).length;
    return `<div class="letter ${n?'':'empty'}" ${n?`onclick="showShelf('${L}')"`:''}>
      <b>${L}</b><span>${n||''}</span></div>`;
  }).join('');
  const next=100-(inked.size%100);
  openPanel(`<div class="phead"><div><h2>Dictionary</h2>
    <div class="sub">${inked.size} words inked · ${next} more to the next milestone</div></div>
    <button onclick="closePanel()">close</button></div>
    <div class="shelf">${shelf}</div>
    <div class="sub-h">how it works</div>
    <div style="color:var(--dim);font-size:13px;line-height:1.6">
      Any real English word you spell from the tray is inked here permanently, even if it
      isn't one of the ${BANK_ALL.length} collection words. There is no completion target —
      the Dictionary is a log of everything you've found, not a checklist.</div>`);
}

function showShelf(L){
  const ws=[...inked].filter(w=>w[0]===L).sort();
  const chips=ws.map(w=>`<span class="wchip" onclick="peekDict('${w}')">${w}</span>`).join('');
  openPanel(`<button class="back" onclick="showDictionary()">← shelves</button>
    <div class="phead"><div><h2>${L.toUpperCase()}</h2>
    <div class="sub">${ws.length} words inked</div></div>
    <button onclick="closePanel()">close</button></div>
    <div class="wgrid">${chips}</div>`);
}

$('book').onclick=showCollection;
$('dictbtn').onclick=showDictionary;






/* ═══════════════════ GAME LANGUAGE ═══════════════════
   Two games from one engine. In English mode you spell English words from
   Latin tiles; in Thai mode you spell Thai words from Thai tiles. The loop,
   the seeding and the cards are identical - only the alphabet and the word
   bank change.

   Thai text is linear in encoding even though vowels render around the
   consonant, so tiles work exactly as they do in English: tap in typing
   order and the font places them.

   Tone marks are free. Thai does not count วรรณยุกต์ as letters, they sit
   above a letter, and making them tiles made half the vocabulary unreachable. */

/* สระ - Thai vowels. These are letters and stay in the tray; only the tone
   marks below are free. Needed so the race draw can balance a tray. */
const THAI_VOWELS = new Set([
  '\u0E30','\u0E31','\u0E32','\u0E33','\u0E34','\u0E35','\u0E36','\u0E37',
  '\u0E38','\u0E39','\u0E40','\u0E41','\u0E42','\u0E43','\u0E44','\u0E4D',
  '\u0E2D','\u0E22','\u0E27'
]);

const FREE_MARKS = new Set(['\u0E47','\u0E48','\u0E49','\u0E4A','\u0E4B','\u0E4C']);
const GAME = CFG.game;   // fixed by the page that loaded the engine

/* One tile per character, tone marks included - they are found and
   tapped/typed in like any other letter now, the same as every other
   mode. A lone tone-mark tile still needs a carrier to render legibly;
   tileGlyph() gives it a dotted circle to sit on, the standard Thai
   keyboard/dictionary convention for a combining mark shown on its own. */
function clusterSpell(s){
  const out=[];
  for(const ch of s) out.push(ch);
  return out;
}

/* Build the Thai bank from the same words.json: the Thai word is the answer,
   the Thai definition is the clue, and the English word becomes the
   translation shown on the card. */

/* ═══════════════════ INTERFACE LANGUAGE ═══════════════════
   Separate from the clue language on purpose. A Thai speaker learning English
   wants Thai menus and English answers; the two settings should not be tied
   together. */
const STR = {
  en:{
    sparks:'sparks', tray:'tray', nextAt:'next at', found:'found', next:'next',
    fillTray:'⚡ fill tray', nextRun:'⏭ next', collection:'📚 collection',
    dictionary:'📖 dictionary', topWords:'📈 top words', reset:'reset',
    words:'🔊 words', letters:'🔤 letters', on:'ON', off:'OFF',
    clue:'clue', playTogether:'PLAY TOGETHER', submit:'Submit', clear:'Clear',
    tapBuild:'tap or type letters · Space is free',
    tapAbove:'tap letters above to build a word',
    lettersN:'letters', waitingYou:'WAITING FOR YOU', lastCall:'LAST CALL',
    anagramTitle:'ANAGRAM', anagramSub:'The tray is full and scrambled — rearrange, don\'t mine.',
    listeningTitle:'LISTENING', listeningSub:'Hear the word, then spell it. No clue until you\'ve guessed.',
    modes:'Modes', modesSub:'choose a language and a way to play', close:'close', youAreHere:'you are here · ',
    modeClassic:'Classic', modeClassicDesc:'Letters drop in on their own while you work.',
    modeAnagram:'Anagram', modeAnagramDesc:'The tray starts full and scrambled — rearrange, don\'t mine.',
    modeListening:'Listening', modeListeningDesc:'Hear the word first — no clue until you\'ve guessed.',
    modePuzzle:'Puzzle', modePuzzleDesc:'Easy, Medium, Hard — clear a stage to unlock the next.',
    modeRace:'Play Together', modeRaceDesc:'Race live or async against someone else.',
    puzzleTitle:'PUZZLE', puzzleSub:'Clear a stage to unlock the next.',
    stageEasy:'Easy', stageMedium:'Medium', stageHard:'Hard',
    solved:'solved', clearedSuffix:' — cleared', lockedStage:'clear the stage before this one first',
    stageClearedWord:'cleared', unlockedWord:'unlocked', allStagesCleared:'that\'s all three stages!',
    chooseOtherStage:'↑ choose a different stage', backToGame:'← back to the game',
    newWord:'⏭ new word', nextWord:'▶ next word', shuffle:'🔀 shuffle', playWord:'🔊 play the word',
    tooShort:'too short', notQuite:'not quite — try again',
    alreadyInCollection:'already in your collection · +1 ✨', alreadyInked:'already inked · +1 ✨',
    inkedInDictionary:'📖 inked in the Dictionary · +2 ✨',
    raceTitle:'RACE', raceIntro:'Same code, same letters, same clues.',
    yourName:'your name', raceCodeLabel:'race code', newCodeBtn:'new code',
    howItEnds:'how it ends', opt2min:'2 min', opt3min:'3 min', opt5min:'5 min',
    optTo300:'to 300', optTo500:'to 500', whoPlaying:'who is playing',
    kindSolo:'just me', kindDuel:'duel · 2', kindParty:'party · up to 10',
    noteSolo:'Play alone. Share the code and compare scores afterwards.',
    noteDuel:'Two players, live scores. You host; they join with your code.',
    noteParty:'Up to ten players, live scores. You host; they join with your code.',
    startBtn:'START', joinRoomBtn:'JOIN A ROOM', trophiesBtn:'🏆 trophies &amp; titles',
    raceBackToGame:'back to the game', raceBack:'back',
    openingRoom:'opening room…', startLower:'start', raceErrSuffix:' — starting a solo race instead',
    waitingRoom:'waiting room', lobbyNote:'Nobody starts until you do — ',
    shareLinkNote:'share this link and they join in one click', copyLinkBtn:'copy link',
    copiedText:'copied', startTheRaceBtn:'start the race', cancelBtn:'cancel',
    joinTitle:'JOIN', joinIntro:'Ask the host for their code.',
    theirRoomCode:'their room code', joinBtn:'JOIN', typeCodeErr:'type the code you were given',
    connectingBtn:'CONNECTING…', youAreIn:'You are in. The race begins when the host starts it.',
    waitingHost:'waiting for the host…', leaveBtn:'leave',
    codeLabel:'code', firstToTimeOut:'first to run out of time',
    firstToPointsPre:'first to ', firstToPointsPost:' points',
    pointsLabel:'points', wordsLabelPlain:'words',
    leaveRaceBtn:'✕ leave the race', reallyLeaveBtn:'✕ really leave? tap again',
    finalStandings:'final standings', yourWords:'your words', noneThisTime:'none this time',
    copyResultBtn:'copy result', raceAgainBtn:'race again', laurelsWord:'laurels', totalWord:'total',
    stillGoing:'still going', copyCodeBtn:'copy code',
    pasteHint:'Paste this into the other device\'s import box.',
    noTitleEquipped:'no title equipped', titlesHeader:'titles — tap one to wear it',
    noneTitleBtn:'none', winTrophyHint:'win a trophy tier to earn one', trophiesHeader:'trophies',
    moveProfile:'move this profile to another device', exportBtn:'export', importBtn:'import',
    pasteCodeLabel:'paste a profile code', loadCodeBtn:'load it',
    codeBadFormat:'that code did not look right',
    statRaces:'races', statWon:'won', statStreakNow:'streak now', statBestStreak:'best streak',
    statBestScore:'best score', statWordsN:'words', statLongWords:'long words',
    statCluesSolved:'clues solved', statSweeps:'sweeps', statOpponents:'opponents',
    flashFreshLetters:'fresh letters', flashPutLetterDown:'put a letter down first',
    flashAlreadyFound:'already found', flashNotAWord:'not a word',
    flashSweep:'every clue on this tray · sweep', flashClueDouble:'clue solved · double points',
    placesFilledSuffix:' places filled',
    errMatchmaking:'could not reach the matchmaking service', errStartRoom:'could not start a room',
    errTimeoutRoom:'timed out starting the room', errConnect:'could not connect',
    errRoomFull:'that room is full', errAlreadyStarted:'that race has already started',
    errReachRoom:'could not reach that room',
    errNoRoom:'no room with that code — check it and try again',
    errCodeInUse:'that code is already in use',
    shareBest:'best', shareTime:'time', shareTrays:'trays',
    readyLabel:'ready', nobodyHereYet:'nobody here yet…',
    roomCountOf:' of ', roomCountSuffix:' in the room', hostLeftRoom:'the host has left the room',
    newLettersIn:'new letters in ',
    leaderboardBtn:'🏆 leaderboard', lbRaceTitle:'Race Leaderboard', lbClassicTitle:'Leaderboard',
    lbNotSetUp:'The leaderboard isn\'t set up yet.', lbLoading:'loading…',
    lbEmpty:'No scores yet — be the first!', lbError:'Could not load the leaderboard right now.',
    lbSignedInAs:'signed in as', lbSignInPrompt:'Sign in to add your name to the leaderboard.',
    lbSaveNameBtn:'save name', lbNameSaved:'name saved',
    authSignInTitle:'SIGN IN', authSignUpTitle:'CREATE ACCOUNT',
    authSub:'Same account as CuppaThai — sign in or create one to put your name on the leaderboard.',
    authEmailPlaceholder:'email', authPasswordPlaceholder:'password',
    authSignInBtn:'Sign in', authSignUpBtn:'Create account',
    authHaveAccount:'Already have an account?', authNoAccount:'Don\'t have an account?',
    authMissingFields:'enter an email and password', authWorking:'working…',
    authCheckEmail:'Check your email to confirm your account, then sign in.',
    authSignOutBtn:'sign out',
    gateTitle:'CuppaThai members only',
    gateSub:'Sign in with your CuppaThai account to play. Not a member? The free version is always open at the GitHub link.',
    modeHangman:'Hangman', modeHangmanDesc:'Guess the word one letter at a time before you run out of guesses.',
    hangmanTitle:'HANGMAN', hangmanSub:'Guess the word one letter at a time.',
    guessesLeft:'guesses left', chooseSkin:'choose a skin',
    youWon:'you got it!', youLost:'out of guesses — the word was',
    skinClassic:'Classic', skinSprout:'Sprout', skinKite:'Kite', skinLantern:'Lantern',
    noThaiVoice:'This device doesn\'t have a Thai voice installed, so the pronunciation may not be right.',
    playAnyway:'🔊 play anyway',
    uiLang:'EN'
  },
  th:{
    sparks:'ประกาย', tray:'ถาด', nextAt:'ขยายที่', found:'พบแล้ว', next:'ถัดไป',
    fillTray:'⚡ เติมถาด', nextRun:'⏭ รอบถัดไป', collection:'📚 คลังคำ',
    dictionary:'📖 พจนานุกรม', topWords:'📈 คำยอดนิยม', reset:'ล้างข้อมูล',
    words:'🔊 อ่านคำ', letters:'🔤 อ่านตัวอักษร', on:'เปิด', off:'ปิด',
    clue:'คำใบ้', playTogether:'เล่นด้วยกัน', submit:'ส่งคำ', clear:'ล้าง',
    tapBuild:'แตะหรือพิมพ์ตัวอักษร · เว้นวรรคฟรี',
    tapAbove:'แตะตัวอักษรด้านบนเพื่อสร้างคำ',
    lettersN:'ตัวอักษร', waitingYou:'รอคุณอยู่', lastCall:'เรียกครั้งสุดท้าย',
    anagramTitle:'สลับคำ', anagramSub:'ถาดเต็มและสลับแล้ว — จัดเรียงใหม่ ไม่ต้องขุดหา',
    listeningTitle:'ฟังคำ', listeningSub:'ฟังคำก่อน แล้วสะกด — ไม่มีคำใบ้จนกว่าจะเดาถูก',
    modes:'โหมด', modesSub:'เลือกภาษาและวิธีเล่น', close:'ปิด', youAreHere:'คุณอยู่ตรงนี้ · ',
    modeClassic:'คลาสสิก', modeClassicDesc:'ตัวอักษรจะทยอยปรากฏเองระหว่างที่คุณทำงาน',
    modeAnagram:'สลับคำ', modeAnagramDesc:'ถาดเต็มและสลับแล้วตั้งแต่ต้น — จัดเรียงใหม่ ไม่ต้องขุดหา',
    modeListening:'ฟังคำ', modeListeningDesc:'ฟังคำก่อน — ไม่มีคำใบ้จนกว่าจะเดาถูก',
    modePuzzle:'ปริศนา', modePuzzleDesc:'ง่าย กลาง ยาก — ผ่านด่านเพื่อปลดล็อกด่านถัดไป',
    modeRace:'เล่นด้วยกัน', modeRaceDesc:'แข่งกับคนอื่นแบบสดหรือย้อนหลังก็ได้',
    puzzleTitle:'ปริศนา', puzzleSub:'ผ่านด่านเพื่อปลดล็อกด่านถัดไป',
    stageEasy:'ง่าย', stageMedium:'กลาง', stageHard:'ยาก',
    solved:'ผ่านแล้ว', clearedSuffix:' — ผ่านแล้ว', lockedStage:'ผ่านด่านก่อนหน้านี้ก่อนเพื่อปลดล็อก',
    stageClearedWord:'ผ่านแล้ว', unlockedWord:'ปลดล็อกแล้ว', allStagesCleared:'ครบทั้งสามด่านแล้ว!',
    chooseOtherStage:'↑ เลือกด่านอื่น', backToGame:'← กลับไปเล่นเกม',
    newWord:'⏭ คำใหม่', nextWord:'▶ คำถัดไป', shuffle:'🔀 สลับใหม่', playWord:'🔊 ฟังคำ',
    tooShort:'สั้นเกินไป', notQuite:'ยังไม่ถูก ลองอีกครั้ง',
    alreadyInCollection:'มีอยู่ในคลังคำแล้ว · +1 ✨', alreadyInked:'บันทึกไว้แล้ว · +1 ✨',
    inkedInDictionary:'📖 บันทึกลงพจนานุกรม · +2 ✨',
    raceTitle:'แข่งขัน', raceIntro:'โค้ดเดียวกัน ตัวอักษรเดียวกัน คำใบ้เดียวกัน',
    yourName:'ชื่อของคุณ', raceCodeLabel:'โค้ดห้องแข่ง', newCodeBtn:'สุ่มโค้ดใหม่',
    howItEnds:'เงื่อนไขจบเกม', opt2min:'2 นาที', opt3min:'3 นาที', opt5min:'5 นาที',
    optTo300:'ถึง 300 แต้ม', optTo500:'ถึง 500 แต้ม', whoPlaying:'ใครเล่นบ้าง',
    kindSolo:'เล่นคนเดียว', kindDuel:'คู่ · 2 คน', kindParty:'ปาร์ตี้ · สูงสุด 10 คน',
    noteSolo:'เล่นคนเดียว แชร์โค้ดแล้วเทียบคะแนนกันทีหลังได้',
    noteDuel:'สองผู้เล่น เห็นคะแนนกันสด คุณเป็นเจ้าห้อง อีกฝ่ายเข้าร่วมด้วยโค้ดของคุณ',
    noteParty:'สูงสุดสิบผู้เล่น เห็นคะแนนกันสด คุณเป็นเจ้าห้อง ทุกคนเข้าร่วมด้วยโค้ดของคุณ',
    startBtn:'เริ่ม', joinRoomBtn:'เข้าร่วมห้อง', trophiesBtn:'🏆 ถ้วยรางวัลและฉายา',
    raceBackToGame:'กลับไปเล่นเกม', raceBack:'ย้อนกลับ',
    openingRoom:'กำลังเปิดห้อง…', startLower:'เริ่ม', raceErrSuffix:' — เริ่มแข่งคนเดียวแทน',
    waitingRoom:'ห้องรอ', lobbyNote:'ไม่มีใครเริ่มได้จนกว่าคุณจะเริ่ม — ',
    shareLinkNote:'แชร์ลิงก์นี้ให้เพื่อนกดเข้าร่วมได้เลย', copyLinkBtn:'คัดลอกลิงก์',
    copiedText:'คัดลอกแล้ว', startTheRaceBtn:'เริ่มการแข่งขัน', cancelBtn:'ยกเลิก',
    joinTitle:'เข้าร่วม', joinIntro:'ขอโค้ดจากเจ้าของห้อง',
    theirRoomCode:'โค้ดห้องของเขา', joinBtn:'เข้าร่วม', typeCodeErr:'พิมพ์โค้ดที่ได้รับมา',
    connectingBtn:'กำลังเชื่อมต่อ…', youAreIn:'เข้าร่วมแล้ว การแข่งจะเริ่มเมื่อเจ้าของห้องเริ่ม',
    waitingHost:'กำลังรอเจ้าของห้อง…', leaveBtn:'ออกจากห้อง',
    codeLabel:'โค้ด', firstToTimeOut:'ใครทำคะแนนได้มากที่สุดเมื่อหมดเวลา',
    firstToPointsPre:'ถึง ', firstToPointsPost:' คะแนนก่อน',
    pointsLabel:'แต้ม', wordsLabelPlain:'คำ',
    leaveRaceBtn:'✕ ออกจากการแข่งขัน', reallyLeaveBtn:'✕ ออกจริงเหรอ? แตะอีกครั้ง',
    finalStandings:'ผลการแข่งขัน', yourWords:'คำของคุณ', noneThisTime:'ไม่มีเลยรอบนี้',
    copyResultBtn:'คัดลอกผลลัพธ์', raceAgainBtn:'แข่งอีกรอบ', laurelsWord:'ใบเกียรติยศ', totalWord:'รวม',
    stillGoing:'กำลังเล่นอยู่', copyCodeBtn:'คัดลอกโค้ด',
    pasteHint:'นำโค้ดนี้ไปวางในช่องนำเข้าของอีกเครื่อง',
    noTitleEquipped:'ยังไม่ได้สวมฉายา', titlesHeader:'ฉายา — แตะเพื่อสวมใส่',
    noneTitleBtn:'ไม่มี', winTrophyHint:'ชนะถ้วยรางวัลสักขั้นเพื่อปลดล็อกฉายา', trophiesHeader:'ถ้วยรางวัล',
    moveProfile:'ย้ายโปรไฟล์นี้ไปเครื่องอื่น', exportBtn:'ส่งออก', importBtn:'นำเข้า',
    pasteCodeLabel:'วางโค้ดโปรไฟล์', loadCodeBtn:'โหลดเลย',
    codeBadFormat:'โค้ดนี้ดูไม่ถูกต้อง',
    statRaces:'แข่งแล้ว', statWon:'ชนะ', statStreakNow:'ชนะรวดตอนนี้', statBestStreak:'ชนะรวดสูงสุด',
    statBestScore:'คะแนนสูงสุด', statWordsN:'คำ', statLongWords:'คำยาว',
    statCluesSolved:'คำใบ้ที่ไข', statSweeps:'กวาดเรียบ', statOpponents:'คู่แข่ง',
    flashFreshLetters:'ตัวอักษรชุดใหม่', flashPutLetterDown:'วางตัวอักษรก่อนสิ',
    flashAlreadyFound:'เจอคำนี้แล้ว', flashNotAWord:'ไม่ใช่คำ',
    flashSweep:'ไขคำใบ้ครบทุกข้อในถาดนี้ · กวาดเรียบ', flashClueDouble:'ไขคำใบ้ได้ · คะแนนคูณสอง',
    placesFilledSuffix:' อันดับเต็มแล้ว',
    errMatchmaking:'ติดต่อระบบจับคู่ไม่ได้', errStartRoom:'เปิดห้องไม่สำเร็จ',
    errTimeoutRoom:'เปิดห้องไม่ทันเวลา', errConnect:'เชื่อมต่อไม่ได้',
    errRoomFull:'ห้องนี้เต็มแล้ว', errAlreadyStarted:'การแข่งขันนี้เริ่มไปแล้ว',
    errReachRoom:'ติดต่อห้องนี้ไม่ได้',
    errNoRoom:'ไม่พบห้องที่ใช้โค้ดนี้ — ตรวจสอบแล้วลองอีกครั้ง',
    errCodeInUse:'โค้ดนี้ถูกใช้งานอยู่แล้ว',
    shareBest:'ดีที่สุด', shareTime:'เวลา', shareTrays:'ถาด',
    readyLabel:'พร้อมแล้ว', nobodyHereYet:'ยังไม่มีใครเข้ามา…',
    roomCountOf:' จาก ', roomCountSuffix:' คนในห้อง', hostLeftRoom:'เจ้าของห้องออกจากห้องแล้ว',
    newLettersIn:'ตัวอักษรชุดใหม่ในอีก ',
    leaderboardBtn:'🏆 ตารางอันดับ', lbRaceTitle:'ตารางอันดับการแข่งขัน', lbClassicTitle:'ตารางอันดับ',
    lbNotSetUp:'ยังไม่ได้ตั้งค่าตารางอันดับ', lbLoading:'กำลังโหลด…',
    lbEmpty:'ยังไม่มีคะแนน — เป็นคนแรกเลยสิ!', lbError:'โหลดตารางอันดับไม่ได้ตอนนี้',
    lbSignedInAs:'เข้าสู่ระบบในชื่อ', lbSignInPrompt:'เข้าสู่ระบบเพื่อใส่ชื่อในตารางอันดับ',
    lbSaveNameBtn:'บันทึกชื่อ', lbNameSaved:'บันทึกชื่อแล้ว',
    authSignInTitle:'เข้าสู่ระบบ', authSignUpTitle:'สร้างบัญชี',
    authSub:'บัญชีเดียวกับ CuppaThai — เข้าสู่ระบบหรือสร้างบัญชีเพื่อใส่ชื่อในตารางอันดับ',
    authEmailPlaceholder:'อีเมล', authPasswordPlaceholder:'รหัสผ่าน',
    authSignInBtn:'เข้าสู่ระบบ', authSignUpBtn:'สร้างบัญชี',
    authHaveAccount:'มีบัญชีอยู่แล้ว?', authNoAccount:'ยังไม่มีบัญชี?',
    authMissingFields:'กรอกอีเมลและรหัสผ่าน', authWorking:'กำลังดำเนินการ…',
    authCheckEmail:'ตรวจอีเมลเพื่อยืนยันบัญชี แล้วเข้าสู่ระบบอีกครั้ง',
    authSignOutBtn:'ออกจากระบบ',
    gateTitle:'สำหรับสมาชิก CuppaThai เท่านั้น',
    gateSub:'เข้าสู่ระบบด้วยบัญชี CuppaThai เพื่อเล่น ยังไม่ได้เป็นสมาชิก? เวอร์ชันฟรีเปิดให้เล่นได้เสมอที่ลิงก์ GitHub',
    modeHangman:'ทายคำ', modeHangmanDesc:'ทายทีละตัวอักษรก่อนที่โอกาสจะหมด',
    hangmanTitle:'ทายคำ', hangmanSub:'ทายคำทีละตัวอักษร',
    guessesLeft:'โอกาสที่เหลือ', chooseSkin:'เลือกลวดลาย',
    youWon:'ทายถูก!', youLost:'หมดโอกาสแล้ว — คำนั้นคือ',
    skinClassic:'คลาสสิก', skinSprout:'ต้นอ่อน', skinKite:'ว่าว', skinLantern:'โคมไฟ',
    noThaiVoice:'อุปกรณ์นี้ไม่มีเสียงพูดภาษาไทยติดตั้งไว้ การออกเสียงอาจไม่ถูกต้องนัก',
    playAnyway:'🔊 เล่นต่อเลย',
    uiLang:'ไทย'
  }
};
let UI = CFG.game==='th' ? 'th' : 'en';
function t(k){ return (STR[UI] && STR[UI][k]) || STR.en[k] || k; }

function applyUI(){
  syncUILang();
  const set=(id,v)=>{ const e=$(id); if(e) e.textContent=v; };
  /* Thai mode has no language choice to make: the answers are Thai and the
     card carries the English translation. One button, not three. */
  const lb=$('lang');
  if(lb) lb.style.display = GAME==='th' ? 'none' : '';
  set('speed', t('fillTray'));
  set('skip',  t('nextRun'));
  set('book',  t('collection'));
  set('dictbtn', t('dictionary'));
  set('promote', t('topWords'));
  set('reset', t('reset'));
  set('lang', lang==='th' ? '✓ ไทย' : '+ ไทย');
  const lbb=$('leaderboard');
  if(lbb){
    lbb.style.display = leaderboardOn() ? '' : 'none';
    lbb.textContent = t('leaderboardBtn');
    lbb.onclick = ()=>showLeaderboard('classic');
  }
  const say=$('say'), sayl=$('sayl');
  if(say)  say.textContent  = t('words')+': '+(sayWords?t('on'):t('off'));
  if(sayl) sayl.textContent = t('letters')+': '+(sayLetters?t('on'):t('off'));
  const sb=$('submit'); if(sb) sb.textContent=t('submit');
  const cb=$('clear');  if(cb) cb.textContent=t('clear');
  const h=document.querySelector('#hint'); if(h) h.textContent=t('tapBuild');
  /* the puzzle overlay's static chrome - none of it changes per session, so
     one pass here (boot + language toggle) is enough; the dynamic bits
     (titles, stage progress, submit feedback) translate themselves inline
     wherever they're generated. */
  set('pzBack', t('backToGame'));
  set('pzClear', t('clear'));
  set('pzSubmit', t('submit'));
  set('pzShuffle', t('shuffle'));
  set('pzPlay', t('playWord'));
  set('pzStageBack', t('chooseOtherStage'));
  renderTray(); renderWordTray(); renderClue();
}

/* ═══════════════════ RACE PROFILE ═══════════════════
   Everything here is local to the player's machine. Racing has its own
   currency and its own progression on purpose: sharing sparks with the main
   game would make racing the fast way to buy hints, and the slow collection
   loop would lose its point. */

const TROPHIES = [
  {key:'wordsmith',  name:'Wordsmith',   stat:'long',     desc:'words of 8 letters or more',
   tiers:[25,150,600,2000],       titles:['Speller','Wordsmith','Lexicographer','Wordwright'],
   th:{name:'นักถ้อยคำ', desc:'คำที่มีแปดตัวอักษรขึ้นไป',
       titles:['ผู้เริ่มสะกด','นักถ้อยคำ','ปราชญ์คำศัพท์','เจ้าแห่งถ้อยคำ']}},
  {key:'codebreaker',name:'Codebreaker', stat:'clues',    desc:'clues solved',
   tiers:[25,150,600,2000],       titles:['Curious','Codebreaker','Clue Hunter','Oracle'],
   th:{name:'นักไขปริศนา', desc:'คำใบ้ที่ไขได้',
       titles:['ผู้ช่างสงสัย','นักไขปริศนา','นักล่าเบาะแส','ผู้หยั่งรู้']}},
  {key:'contender',  name:'Contender',   stat:'races',    desc:'races finished',
   tiers:[10,50,250,1000],        titles:['Newcomer','Regular','Contender','Veteran'],
   th:{name:'ผู้ท้าชิง', desc:'การแข่งที่จบแล้ว',
       titles:['มือใหม่','ขาประจำ','ผู้ท้าชิง','ทหารผ่านศึก']}},
  {key:'victor',     name:'Victor',      stat:'wins',     desc:'races won',
   tiers:[5,25,100,400],          titles:['First Blood','Winner','Champion','Undefeated'],
   th:{name:'ผู้พิชิต', desc:'การแข่งที่ชนะ',
       titles:['ชัยชนะแรก','ผู้ชนะ','แชมป์','ไร้พ่าย']}},
  {key:'streak',     name:'Streak',      stat:'beststreak',desc:'wins in a row',
   tiers:[3,6,12,20],             titles:['On a Roll','Hot Hand','Unstoppable','Dynasty'],
   th:{name:'สายชนะรวด', desc:'ชนะติดต่อกันกี่ครั้ง',
       titles:['กำลังมาแรง','มือร้อนแรง','หยุดไม่อยู่','ราชวงศ์']}},
  {key:'sweeper',    name:'Sweeper',     stat:'sweeps',   desc:'trays with every clue solved',
   tiers:[3,25,100,400],          titles:['Tidy','Sweeper','Clean Slate','Immaculate'],
   th:{name:'นักกวาดเรียบ', desc:'ถาดที่ไขคำใบ้ครบทุกข้อ',
       titles:['เรียบร้อย','นักกวาดเรียบ','ล้างกระดานสะอาด','ไร้ที่ติ']}},
  {key:'prolific',   name:'Prolific',    stat:'words',    desc:'words found in races',
   tiers:[500,5000,25000,100000], titles:['Busy','Prolific','Machine','Encyclopedia'],
   th:{name:'นักปั่นคำ', desc:'คำที่พบระหว่างแข่ง',
       titles:['ขยันขันแข็ง','นักปั่นคำ','เครื่องจักร','สารานุกรมเดินได้']}},
  {key:'highscore',  name:'Highscore',   stat:'best',     desc:'best score in one race',
   tiers:[300,750,1500,3000],     titles:['Sharp','Brilliant','Peerless','Legendary'],
   th:{name:'คะแนนสูงสุด', desc:'คะแนนสูงสุดในหนึ่งการแข่ง',
       titles:['เฉียบคม','เจิดจรัส','ไร้เทียบ','ระดับตำนาน']}},
  {key:'sociable',   name:'Sociable',    stat:'opponents',desc:'different people raced',
   tiers:[5,20,60,200],           titles:['Friendly','Sociable','Ringleader','Host of Hosts'],
   th:{name:'นักเข้าสังคม', desc:'จำนวนคนต่างกันที่เคยแข่งด้วย',
       titles:['เป็นมิตร','เข้าสังคมเก่ง','หัวหน้าแก๊ง','เจ้าภาพระดับปรมาจารย์']}},
];
/* TIER_NAME stays the English slugs on purpose - the CSS (.lit.silver,
   .tro.gold, etc.) keys off them as class names, in both languages.
   TIER_LABEL is the separate, translatable text shown to the player. */
const TIER_NAME  = ['bronze','silver','gold','platinum'];
const TIER_LABEL = {en:['bronze','silver','gold','platinum'], th:['ทองแดง','เงิน','ทอง','แพลทินัม']};
const TIER_LAUREL= [25, 75, 200, 500];    // paid out when a tier unlocks
function trophyName(t){ return GAME==='th' ? t.th.name : t.name; }
function trophyDesc(t){ return GAME==='th' ? t.th.desc : t.desc; }
function trophyTitle(t,i){ return GAME==='th' ? t.th.titles[i] : t.titles[i]; }
function tierLabel(i){ return TIER_LABEL[GAME==='th'?'th':'en'][i]; }

/* ═══════════════════ LEADERBOARD (off until configured) ═══════════════════
   Needs CFG.supabaseUrl/supabaseKey filled in (see the config block in the
   HTML). Until then every function here is a quiet no-op - nothing else in
   the game may ever assume a leaderboard exists.

   Putting a name on the board requires a real CuppaThai account (the same
   Supabase project the dashboard uses) - browsing the board doesn't.
   Anyone can still play and see who's on it; only a signed-in player's
   score actually gets written, and the database enforces that itself
   (see leaderboard-schema.sql's auth.uid() policies) rather than trusting
   this file not to be bypassed. */
let SB=null;
function sbClient(){
  if(SB!==null) return SB;
  if(!CFG.supabaseUrl || !CFG.supabaseKey || typeof supabase==='undefined'){ SB=false; return SB; }
  try{ SB=supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey); }catch(e){ SB=false; }
  return SB;
}
function leaderboardOn(){ return !!sbClient(); }

let AUTH_USER=null, AUTH_READY=false;
async function authInit(){
  const cl=sbClient(); if(!cl) return;
  try{
    const { data } = await cl.auth.getSession();
    AUTH_USER = data?.session?.user ? {id:data.session.user.id, email:data.session.user.email} : null;
  }catch(e){}
  AUTH_READY = true;
  cl.auth.onAuthStateChange((event, session)=>{
    AUTH_USER = session?.user ? {id:session.user.id, email:session.user.email} : null;
  });
}
async function authSignUp(email, password){
  const cl=sbClient(); if(!cl) return {error:'not configured'};
  const { data, error } = await cl.auth.signUp({ email, password });
  if(!error && data.user && data.session) AUTH_USER = {id:data.user.id, email:data.user.email};
  return { error: error?.message, needsConfirm: !error && !data.session };
}
async function authSignIn(email, password){
  const cl=sbClient(); if(!cl) return {error:'not configured'};
  const { data, error } = await cl.auth.signInWithPassword({ email, password });
  if(!error && data.user) AUTH_USER = {id:data.user.id, email:data.user.email};
  return { error: error?.message };
}
async function authSignOut(){
  const cl=sbClient(); if(!cl) return;
  try{ await cl.auth.signOut(); }catch(e){}
  AUTH_USER = null;
}

/* Only ever used for pre-account rows and, if you ever want it, a "these
   were played before you signed in" merge - real leaderboard writes use
   AUTH_USER.id instead, see submitRaceScore/submitClassicScore below. */
function playerId(){
  let id=localStorage.getItem('vocap-player-id');
  if(!id){
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
       : 'p-'+Math.random().toString(36).slice(2)+Date.now().toString(36);
    localStorage.setItem('vocap-player-id', id);
  }
  return id;
}

/* A network hiccup here must never interrupt the result screen it was
   called from - it already rendered by the time this runs. Signed-out
   players simply don't get a row; nothing about play is blocked either
   way, so this stays a quiet no-op rather than an error the player sees. */
async function submitRaceScore(score, words){
  const cl=sbClient(); if(!cl || !AUTH_USER) return;
  try{
    /* insert() resolves with {error} rather than throwing on a rejected
       write (an RLS policy mismatch, for instance) - swallowing it here
       unseen made that failure mode indistinguishable from success. */
    const {error} = await cl.from('vocap_race_scores').insert({
      player_id:AUTH_USER.id, name:netName(), score, words, lang:GAME
    });
    if(error) console.error('submitRaceScore failed:', error);
  }catch(e){ console.error('submitRaceScore threw:', e); }
}

/* The longest curated word in the collection so far - computed on demand
   from `seen` rather than tracked as its own piece of save state, since it
   only has to exist at the moment a leaderboard row is written. */
function longestSeenWord(){
  let word=null, len=0;
  for(const id of seen){
    const w=BANK_ALL.find(x=>x.id===id);
    if(w && w.letters>len){ len=w.letters; word=w.word; }
  }
  return {word, len};
}

async function submitClassicScore(){
  const cl=sbClient(); if(!cl || !AUTH_USER) return;
  const {word,len}=longestSeenWord();
  try{
    const {error} = await cl.from('vocap_classic_scores').upsert({
      player_id:AUTH_USER.id, lang:GAME, name:netName(),
      words_found:seen.size, sparks, longest_word:word, longest_len:len,
      updated_at:new Date().toISOString()
    }, {onConflict:'player_id,lang'});
    if(error) console.error('submitClassicScore failed:', error);
  }catch(e){ console.error('submitClassicScore threw:', e); }
}

/* Two different homes depending on where this was opened from: the classic
   toolbar has no overlay open yet, so the generic panel is free to use. The
   race version is opened from inside #race, which sits above #panel in the
   stacking order - rendering into #panel there would draw the board behind
   the still-open race screen instead of over it. Auth reuses the same
   split, since it's always reached from the leaderboard. */
function lbRender(html){
  if($('race') && $('race').className==='show') $('race').innerHTML = html;
  else openPanel(html);
}
let LB_RETURN_KIND='classic';
function lbAccountBlock(){
  if(AUTH_USER) return `<div class="lbaccount">
      <span>${t('lbSignedInAs')} <b>${esc(AUTH_USER.email)}</b></span>
      <button onclick="authSignOutAndRefresh()">${t('authSignOutBtn')}</button>
    </div>
    <div class="lbnamerow">
      <input id="lbNameInput" value="${esc(netName())}" maxlength="14">
      <button onclick="lbSaveName()">${t('lbSaveNameBtn')}</button>
    </div>`;
  return `<div class="lbaccount">
      <span>${t('lbSignInPrompt')}</span>
      <button class="primary" onclick="showAuthPanel('signin')">${t('authSignInBtn')}</button>
    </div>`;
}
function lbSaveName(){
  const v = ($('lbNameInput').value||'player').trim().slice(0,14) || 'player';
  localStorage.setItem('vocap-name', v);
  flash(t('lbNameSaved'),'good');
}
async function showLeaderboard(kind){
  if(kind!=='race') closePanel();
  LB_RETURN_KIND = kind;
  const title = kind==='race' ? t('lbRaceTitle') : t('lbClassicTitle');
  const backBtn = kind==='race'
    ? `<button onclick="raceSetup()">${t('raceBack')}</button>`
    : `<button onclick="closePanel()">${t('close')}</button>`;
  const head = `<div class="sheet"><div class="phead"><div><h2>${title}</h2></div>${backBtn}</div>`;
  const foot = '</div>';
  const cl=sbClient();
  if(!cl){ lbRender(`${head}<div class="sub">${t('lbNotSetUp')}</div>${foot}`); return; }
  const acct = lbAccountBlock();
  lbRender(`${head}${acct}<div class="sub">${t('lbLoading')}</div>${foot}`);
  try{
    const table = kind==='race' ? 'vocap_race_scores' : 'vocap_classic_scores';
    const orderCol = kind==='race' ? 'score' : 'words_found';
    const {data,error} = await cl.from(table).select('*')
        .eq('lang', GAME).order(orderCol,{ascending:false}).limit(20);
    if(error) throw error;
    const rows=data||[];
    const body = rows.length ? `<div class="lbboard">${rows.map((r,i)=>
        kind==='race'
          ? `<div class="lbrow"><span class="lbpos">${i+1}</span><span class="lbname">${esc(r.name)}</span><span class="lbval">${r.score} ✨ · ${r.words} ${t('wordsLabelPlain')}</span></div>`
          : `<div class="lbrow"><span class="lbpos">${i+1}</span><span class="lbname">${esc(r.name)}</span><span class="lbval">${r.words_found} ${t('wordsLabelPlain')}${r.longest_word?` · ${esc(r.longest_word)}`:''}</span></div>`
      ).join('')}</div>` : `<div class="sub">${t('lbEmpty')}</div>`;
    lbRender(`${head}${acct}${body}${foot}`);
  }catch(e){
    lbRender(`${head}${acct}<div class="sub">${t('lbError')}</div>${foot}`);
  }
}
function authSignOutAndRefresh(){ authSignOut().then(()=>showLeaderboard(LB_RETURN_KIND)); }

function showAuthPanel(mode){
  mode = mode==='signup' ? 'signup' : 'signin';
  const isUp = mode==='signup';
  const toggle = isUp
    ? `${t('authHaveAccount')} <a href="#" onclick="showAuthPanel('signin');return false;">${t('authSignInBtn')}</a>`
    : `${t('authNoAccount')} <a href="#" onclick="showAuthPanel('signup');return false;">${t('authSignUpBtn')}</a>`;
  lbRender(`<div class="sheet"><div class="phead"><div><h2>${isUp?t('authSignUpTitle'):t('authSignInTitle')}</h2></div>
      <button onclick="showLeaderboard(LB_RETURN_KIND)">${t('close')}</button></div>
      <div class="sub">${t('authSub')}</div>
      <input id="authEmail" type="email" placeholder="${t('authEmailPlaceholder')}" autocomplete="email">
      <input id="authPassword" type="password" placeholder="${t('authPasswordPlaceholder')}"
             autocomplete="${isUp?'new-password':'current-password'}">
      <div class="msg" id="authMsg"></div>
      <div class="row"><button class="primary" onclick="authSubmit('${mode}')">${isUp?t('authSignUpBtn'):t('authSignInBtn')}</button></div>
      <div class="sub" style="margin-top:10px">${toggle}</div>
    </div>`);
}
async function authSubmit(mode){
  const email=($('authEmail').value||'').trim(), password=$('authPassword').value||'';
  const msgEl=$('authMsg');
  if(!email || !password){ msgEl.textContent=t('authMissingFields'); msgEl.className='msg bad'; return; }
  msgEl.textContent=t('authWorking'); msgEl.className='msg';
  const result = mode==='signup' ? await authSignUp(email,password) : await authSignIn(email,password);
  if(result.error){ msgEl.textContent=result.error; msgEl.className='msg bad'; return; }
  if(result.needsConfirm){ msgEl.textContent=t('authCheckEmail'); msgEl.className='msg good'; return; }
  showLeaderboard(LB_RETURN_KIND);
}

/* The CuppaThai-hosted copy only: CFG.requireAuth blocks play until a real
   account is signed in. #authgate is a separate element from #overlay/#panel
   on purpose - it has no close button and doesn't answer to Escape or an
   outside click, so it can't be dismissed the way every other panel can. */
function renderAuthGate(mode){
  mode = mode==='signup' ? 'signup' : 'signin';
  const isUp = mode==='signup';
  const toggle = isUp
    ? `${t('authHaveAccount')} <a href="#" onclick="renderAuthGate('signin');return false;">${t('authSignInBtn')}</a>`
    : `${t('authNoAccount')} <a href="#" onclick="renderAuthGate('signup');return false;">${t('authSignUpBtn')}</a>`;
  $('authgatePanel').innerHTML = `
      <h2>${t('gateTitle')}</h2>
      <div class="sub">${t('gateSub')}</div>
      <div class="sub" style="margin-top:14px"><b>${isUp?t('authSignUpTitle'):t('authSignInTitle')}</b></div>
      <input id="gateEmail" type="email" placeholder="${t('authEmailPlaceholder')}" autocomplete="email">
      <input id="gatePassword" type="password" placeholder="${t('authPasswordPlaceholder')}"
             autocomplete="${isUp?'new-password':'current-password'}">
      <div class="msg" id="gateMsg"></div>
      <div class="row"><button class="primary" onclick="authGateSubmit('${mode}')">${isUp?t('authSignUpBtn'):t('authSignInBtn')}</button></div>
      <div class="sub" style="margin-top:10px">${toggle}</div>`;
  $('authgate').className = 'show';
}
async function authGateSubmit(mode){
  const email=($('gateEmail').value||'').trim(), password=$('gatePassword').value||'';
  const msgEl=$('gateMsg');
  if(!email || !password){ msgEl.textContent=t('authMissingFields'); msgEl.className='msg bad'; return; }
  msgEl.textContent=t('authWorking'); msgEl.className='msg';
  const result = mode==='signup' ? await authSignUp(email,password) : await authSignIn(email,password);
  if(result.error){ msgEl.textContent=result.error; msgEl.className='msg bad'; return; }
  if(result.needsConfirm){ msgEl.textContent=t('authCheckEmail'); msgEl.className='msg good'; return; }
  $('authgate').className = '';
  enterGame();
}

const BLANK_PROFILE = {
  name:'player', laurels:0, title:'',
  stats:{long:0, clues:0, races:0, wins:0, streak:0, beststreak:0,
         sweeps:0, words:0, best:0, opponents:0},
  met:[],            // names raced against, for the Sociable count
  tiers:{},          // key -> highest tier index reached (0-based)
  history:[]         // last 20 races, newest first
};

let PROF = null;
/* Trophies and titles are per-language now - what you earned racing in
   English has nothing to do with the Thai game, and shouldn't already
   show as unlocked there. The two used to share one key; on English's
   first load under the new key we hand it the old shared data rather
   than erase it, and Thai starts clean. */
const RACE_PROFILE_KEY = 'vocap-race-profile-'+GAME;

function profLoad(){
  try{
    let raw = localStorage.getItem(RACE_PROFILE_KEY);
    if(raw==null && GAME==='en') raw = localStorage.getItem('vocap-race-profile');
    PROF = JSON.parse(raw) || null;
  }catch(e){ PROF=null; }
  if(!PROF) PROF = JSON.parse(JSON.stringify(BLANK_PROFILE));
  // fill in anything a newer version added
  for(const k in BLANK_PROFILE.stats) if(!(k in PROF.stats)) PROF.stats[k]=0;
  PROF.name = localStorage.getItem('vocap-name') || PROF.name;
  return PROF;
}
function profSave(){
  try{ localStorage.setItem(RACE_PROFILE_KEY, JSON.stringify(PROF)); }catch(e){}
}

function tierOf(t){
  const v = PROF.stats[t.stat] || 0;
  let i = -1;
  t.tiers.forEach((n,k)=>{ if(v>=n) i=k; });
  return i;                      // -1 = not started
}

/* Called once at the end of a race. Returns the tiers newly unlocked so the
   result screen can announce them. */
function profRecord(result){
  profLoad();
  const s = PROF.stats;
  s.races++;
  s.words   += result.words;
  s.long    += result.long;
  s.clues   += result.clues;
  s.sweeps  += result.sweeps;
  s.best     = Math.max(s.best, result.score);
  if(result.won){ s.wins++; s.streak++; s.beststreak=Math.max(s.beststreak,s.streak); }
  else if(result.ranked) s.streak = 0;
  for(const n of result.opponents||[]){
    if(n && n!==PROF.name && !PROF.met.includes(n)) PROF.met.push(n);
  }
  s.opponents = PROF.met.length;

  const unlocked=[];
  for(const tr of TROPHIES){
    const now = tierOf(tr), was = (tr.key in PROF.tiers) ? PROF.tiers[tr.key] : -1;
    if(now > was){
      for(let k=was+1;k<=now;k++){
        PROF.laurels += TIER_LAUREL[k];
        unlocked.push({t:tr, k});
      }
      PROF.tiers[tr.key]=now;
    }
  }
  PROF.laurels += result.won ? 30 : 10;      // showing up pays, winning pays more

  PROF.history.unshift({score:result.score, words:result.words,
                        won:!!result.won, when:Date.now()});
  PROF.history = PROF.history.slice(0,20);
  profSave();
  return unlocked;
}

function profTitles(){
  profLoad();
  const out=[];
  for(const tr of TROPHIES){
    const i = (tr.key in PROF.tiers) ? PROF.tiers[tr.key] : -1;
    for(let k=0;k<=i;k++) out.push({key:tr.key+':'+k, label:trophyTitle(tr,k), tier:k, cat:trophyName(tr)});
  }
  return out;
}

/* A profile lives in one browser on one machine, so this is the only way to
   carry it to a phone or a new laptop. */
function profExport(){
  return btoa(unescape(encodeURIComponent(JSON.stringify(PROF))));
}
function profImport(code){
  try{
    const o=JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
    if(!o || !o.stats) return false;
    PROF=o; profSave(); return true;
  }catch(e){ return false; }
}

/* ═══════════════════ LIVE RACE ROOMS ═══════════════════
   Optional networking for race mode only. Nothing here runs unless the player
   opens a race and chooses to go online: the library is fetched on demand, and
   every failure path falls back to playing solo rather than blocking the game.

   Topology is a star. The host holds the room and relays scores; joiners talk
   only to the host. Words are never sent - only names and totals. */

const MAX_DUEL = 2, MAX_PARTY = 10;
let NET = null;   // {peer, conns, isHost, roster, code, cap, myId}

function loadPeerJS(){
  if(window.Peer) return Promise.resolve(true);
  return new Promise(res=>{
    const s=document.createElement('script');
    s.src='https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.crossOrigin='anonymous';
    s.onload=()=>res(true);
    s.onerror=()=>res(false);         // offline or blocked: caller falls back
    document.head.appendChild(s);
    setTimeout(()=>res(!!window.Peer), 15000);
  });
}

function netName(){
  return (localStorage.getItem('vocap-name') || 'player').slice(0,14);
}

function netBroadcast(msg){
  if(!NET) return;
  for(const c of NET.conns) { try{ c.send(msg); }catch(e){} }
}

/* Every player is identified by their peer id, never by their name. Two people
   called "mango" are two players; someone who leaves and rejoins is a new one.
   Keying on name was why a father and son could not sit in the same room. */
function netUpsert(id, name, row){
  if(!NET) return;
  const i = NET.roster.findIndex(r => r.id === id);
  const entry = {id, name, title:row.title||'', score:row.score|0,
                 words:row.words|0, done:!!row.done};
  if(i >= 0) NET.roster[i] = entry; else NET.roster.push(entry);
  NET.roster.sort((a,b)=>b.score-a.score);
  renderRoster();
}

function netRemove(id){
  if(!NET) return;
  NET.roster = NET.roster.filter(r => r.id !== id);
  renderRoster();
  if(NET.isHost) netBroadcast({t:'roster', roster:NET.roster});
}

/* A race to a point target ends when three people have got there - or when
   everyone has, in a smaller room. Without this the leaders sit watching while
   the rest grind out a target that no longer decides anything. */
function netCheckPodium(id, name, score){
  if(!NET || !NET.isHost || !R || !R.target || R.over) return;
  if(score < R.target) return;
  if(NET.podium.some(p=>p.id===id)) return;
  NET.podium.push({id, name, place:NET.podium.length+1});
  netBroadcast({t:'podium', podium:NET.podium});
  const need = Math.min(3, Math.max(1, NET.roster.length));
  if(NET.podium.length >= need){
    netBroadcast({t:'raceover', podium:NET.podium});
    raceEnd();
  }
}

function netSendScore(){
  if(!NET || !R) return;
  const row = {t:'score', id:NET.myId, name:netName(), title:(PROF&&PROF.title)||'',
               score:R.score, words:R.found.length, done:!!R.over};
  if(NET.isHost){
    netUpsert(NET.myId, netName(), row);
    netCheckPodium(NET.myId, netName(), R.score);
    netBroadcast({t:'roster', roster:NET.roster});
  } else {
    netBroadcast(row);
  }
}

/* Names are not unique, so if two players share one we number them. Without
   this a room of "player, player, player" is unreadable. */
function displayNames(rows){
  const seen={};
  return rows.map(r=>{
    seen[r.name] = (seen[r.name]||0)+1;
    return {...r, label: seen[r.name]>1 ? `${r.name} (${seen[r.name]})` : r.name};
  });
}

function renderRoster(){
  const el=$('rroster'); if(!el || !NET) return;
  const racing = !!(R && !R.over);
  const rows = displayNames(NET.roster);
  el.innerHTML = rows.map((r,i)=>
    `<div class="rrow${r.id===NET.myId?' me':''}">
       <span>${racing?(i+1)+'. ':'· '}${esc(r.label)}${r.title?`<em>${esc(r.title)}</em>`:''}</span>
       ${racing ? `<span><b>${r.score}</b> · ${r.words}w ${r.done?'✔':''}</span>`
                : `<span class="sub" style="font-size:11px">${t('readyLabel')}</span>`}
     </div>`).join('') || `<div class="sub">${t('nobodyHereYet')}</div>`;
  const c=$('rcount');
  if(c) c.textContent = `${NET.roster.length}${t('roomCountOf')}${NET.cap}${t('roomCountSuffix')}`;
}

async function netHost(code, cap){
  const ok=await loadPeerJS();
  if(!ok) return {error:t('errMatchmaking')};
  return new Promise(res=>{
    let peer;
    try{ peer = new Peer('vocap-'+code); }catch(e){ return res({error:t('errStartRoom')}); }
    peer.on('open', id=>{
      NET={peer, conns:[], isHost:true, roster:[], code, cap, myId:id,
           locked:false, podium:[]};
      netUpsert(id, netName(), {score:0, words:0, done:false, title:(profLoad().title||'')});
      peer.on('connection', c=>{
        /* Once the clock is running the field is closed. Letting somebody in
           forty seconds late gives them a shorter race and a worse tray, and
           makes the standings meaningless. */
        if(NET.locked){ try{c.send({t:'started'});setTimeout(()=>c.close(),200);}catch(e){} return; }
        if(NET.roster.length >= cap){ try{c.send({t:'full'});setTimeout(()=>c.close(),200);}catch(e){} return; }
        NET.conns.push(c);
        c.on('data', m=>{
          if(m.t==='hello'){ c.__pid=m.id; netUpsert(m.id, m.name, {score:0,words:0,done:false,title:m.title});
                             netBroadcast({t:'roster', roster:NET.roster}); }
          if(m.t==='score'){ c.__pid=m.id; netUpsert(m.id, m.name, m);
                             netCheckPodium(m.id, m.name, m.score);
                             netBroadcast({t:'roster', roster:NET.roster}); }
          if(m.t==='bye'){ netRemove(m.id); }
        });
        const gone = ()=>{ NET.conns=NET.conns.filter(x=>x!==c);
                           if(c.__pid) netRemove(c.__pid); };
        c.on('close', gone);
        c.on('error', gone);
      });
      res({ok:true});
    });
    peer.on('error', e=>{
      res({error: String(e).includes('taken') ? t('errCodeInUse')
                                              : t('errStartRoom')});
    });
    setTimeout(()=>res({error:t('errTimeoutRoom')}), 20000);
  });
}

async function netJoin(code){
  const ok=await loadPeerJS();
  if(!ok) return {error:t('errMatchmaking')};
  return new Promise(res=>{
    let peer, settled=false;
    const done=v=>{ if(!settled){ settled=true; res(v); } };
    try{ peer = new Peer(); }catch(e){ return done({error:t('errConnect')}); }
    peer.on('open', myId=>{
      const c=peer.connect('vocap-'+code, {reliable:true});
      c.on('open', ()=>{
        NET={peer, conns:[c], isHost:false, roster:[], code, cap:MAX_PARTY, myId};
        c.send({t:'hello', id:myId, name:netName(), title:(profLoad().title||'')});
        done({ok:true});
      });
      c.on('data', m=>{
        if(m.t==='roster'){ NET.roster=m.roster; renderRoster(); }
        if(m.t==='start'){ raceStart(m.mode, true); }
        if(m.t==='podium'){ if(NET) NET.podium=m.podium; racePodiumNote(); }
        if(m.t==='raceover'){ if(NET) NET.podium=m.podium; raceEnd(); }
        if(m.t==='full'){ done({error:t('errRoomFull')}); }
        if(m.t==='started'){ done({error:t('errAlreadyStarted')}); }
        if(m.t==='hostleft'){ raceHostGone(); }
      });
      c.on('close', ()=>{ if(NET && !NET.isHost) raceHostGone(); });
      c.on('error', ()=>done({error:t('errReachRoom')}));
      /* Phones on mobile data routinely take longer than nine seconds to
         negotiate a peer connection, which was reported as "cannot join". */
      setTimeout(()=>done({error:t('errNoRoom')}), 25000);
    });
    peer.on('error', ()=>done({error:t('errConnect')}));
  });
}

function raceHostGone(){
  const el=$('rroster');
  if(el) el.insertAdjacentHTML('beforebegin',
    `<div class="sub" style="color:var(--bad)">${t('hostLeftRoom')}</div>`);
}

/* Announce departure so the roster does not keep a ghost. The host also
   catches the connection closing, so a crash is handled too. */
function netLeave(){
  if(!NET) return;
  try{
    if(!NET.isHost) netBroadcast({t:'bye', id:NET.myId});
    else netBroadcast({t:'hostleft'});
  }catch(e){}
  try{ NET.peer.destroy(); }catch(e){}
  NET=null;
}

/* ═══════════════════ RACE MODE ═══════════════════
   Deliberately separate from the collection. Race finds do not fill topics
   and race points are not sparks, because otherwise racing would become the
   efficient way to finish the game and the slow loop would lose its purpose. */

let R = null;   // active race state, or null

/* A tiny deterministic generator. Two people typing the same code must get
   exactly the same fifteen letters, so nothing here may use Math.random. */
function seedRNG(str){
  let h = 2166136261;
  for(const ch of str.toUpperCase()){
    h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619);
  }
  return function(){
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/* Fresh letters and fresh clues every minute, in every mode. A fixed cadence
   means a 2-minute sprint and a race to 500 points feel like the same game,
   and nobody can sit on one lucky tray. */
const RACE_ROUND = 60;
/* Thai needs a wider race tray for the same reason its solo tray is wider. */
const RACE_TILES = ()=> GAME==='th' ? 18 : 15;

/* A race tray is built around its clues rather than drawn at random and
   checked afterwards. Sampling letters and hoping three words happen to fit
   works in English and fails badly in Thai: with 61 tile characters instead of
   26, two thirds of random trays contained no whole word at all, so the Thai
   race had no clues to show.

   Both players run this from the same seed, so both get the same tray and the
   same targets without anything passing between them. */
function raceBuild(code, round, size){
  const rnd = seedRNG(code + ':tray:' + round);
  const bands = GAME==='th' ? [[3,5],[4,6],[5,7]] : [[3,4],[4,5],[4,6]];

  const acc = {}, chosen = [];
  const fits = m => Object.values(m).reduce((a,b)=>a+b,0) <= size;
  for(const [lo,hi] of bands){
    const cands = BANK_ALL.filter(w => w.letters>=lo && w.letters<=hi
                                    && !chosen.includes(w));
    if(!cands.length) continue;
    for(let attempt=0; attempt<60; attempt++){
      const w = cands[Math.floor(rnd()*cands.length)];
      const trial = {...acc};
      for(const [ch,k] of Object.entries(count(w.spell))) trial[ch]=(trial[ch]||0)+k;
      if(fits(trial)){
        Object.assign(acc, trial); chosen.push(w); break;
      }
    }
  }

  // fill the rest by letter frequency so there is more to find than the clues
  const letters = [];
  for(const [ch,k] of Object.entries(acc)) for(let i=0;i<k;i++) letters.push(ch);
  const pool = Object.entries(FREQ), tot = pool.reduce((a,[,w])=>a+w,0);
  let guard = size*40;
  while(letters.length < size && guard-- > 0){
    let r = rnd()*tot;
    for(const [ch,w] of pool){ r-=w; if(r<=0){ letters.push(ch); break; } }
  }

  // deterministic shuffle, so the clue letters are not all at the front
  for(let i=letters.length-1;i>0;i--){
    const j = Math.floor(rnd()*(i+1));
    [letters[i],letters[j]] = [letters[j],letters[i]];
  }
  return {letters, clues:chosen};
}

/* Pick clue words that can actually be spelled from this tray. Both players
   run the same filter over the same word list in the same order, so the
   targets match without anything being sent between them. */
function newCode(){
  const A='BCDFGHJKLMNPQRSTVWXYZ23456789';
  let s=''; for(let i=0;i<5;i++) s+=A[Math.floor(Math.random()*A.length)];
  return s;
}

function openRace(code){ $('race').className='show'; raceSetup();
  if(code && $('rcode')) $('rcode').value=code.toUpperCase(); }
function closeRace(){ $('race').className=''; R=null; netLeave(); }

function raceSetup(){
  const code = (R && R.code) || newCode();
  netLeave();
  $('race').innerHTML = `
    <div class="sheet">
      <h2>${t('raceTitle')}</h2>
      <div class="sub">${t('raceIntro')}</div>

      <div class="field">
        <label>${t('yourName')}</label>
        <input id="rname" value="${esc(netName())}" maxlength="14" style="letter-spacing:1px">
      </div>

      <div class="field">
        <label>${t('raceCodeLabel')}</label>
        <input id="rcode" value="${code}" maxlength="8">
        <div style="margin-top:8px"><button onclick="$('rcode').value=newCode()">${t('newCodeBtn')}</button></div>
      </div>

      <div class="field">
        <label>${t('howItEnds')}</label>
        <div class="opts" id="rmode">
          <button data-m="t120" class="on">${t('opt2min')}</button>
          <button data-m="t180">${t('opt3min')}</button>
          <button data-m="t300">${t('opt5min')}</button>
          <button data-m="p300">${t('optTo300')}</button>
          <button data-m="p500">${t('optTo500')}</button>
        </div>
      </div>

      <div class="field">
        <label>${t('whoPlaying')}</label>
        <div class="opts" id="rkind">
          <button data-k="solo" class="on">${t('kindSolo')}</button>
          <button data-k="duel">${t('kindDuel')}</button>
          <button data-k="party">${t('kindParty')}</button>
        </div>
        <div class="sub" id="rkindnote" style="margin-top:8px">
          ${t('noteSolo')}
        </div>
      </div>

      <div class="gorow">
        <button class="go" id="rgo" onclick="raceGo()">${t('startBtn')}</button>
        <button class="go alt" id="rjoin" onclick="raceJoinScreen()">${t('joinRoomBtn')}</button>
      </div>
      <div class="sub" id="rerr" style="color:var(--bad);margin-top:10px"></div>
      <div style="margin-top:16px">
        <button onclick="raceProfile()">${t('trophiesBtn')}</button>
        ${leaderboardOn() ? `<button onclick="showLeaderboard('race')">${t('leaderboardBtn')}</button>` : ''}
        <button onclick="closeRace()">${t('raceBackToGame')}</button>
      </div>
    </div>`;

  for(const id of ['rmode','rkind']){
    const g=$(id);
    g.onclick=e=>{
      if(!e.target.dataset.m && !e.target.dataset.k) return;
      [...g.children].forEach(b=>b.className=''); e.target.className='on';
      if(id==='rkind'){
        const k=e.target.dataset.k;
        $('rkindnote').textContent =
          k==='solo'  ? t('noteSolo') :
          k==='duel'  ? t('noteDuel') :
                        t('noteParty');
      }
    };
  }
}

function raceLink(code){
  const base = location.protocol==='http:' || location.protocol==='https:'
      ? location.origin + location.pathname
      : 'https://YOUR-GITHUB-PAGES-URL/';
  return `${base}?race=${code}`;
}


function raceProfile(){
  profLoad();
  const s=PROF.stats;
  const titles=profTitles();
  $('race').innerHTML=`
    <div class="sheet">
      <h2>${esc(PROF.name)}</h2>
      <div class="sub">${PROF.title ? esc(PROF.title) : t('noTitleEquipped')} · <b style="color:var(--glow)">${PROF.laurels}</b> ${t('laurelsWord')}</div>

      <div class="statgrid">
        ${[['races',t('statRaces')],['wins',t('statWon')],['streak',t('statStreakNow')],['beststreak',t('statBestStreak')],
           ['best',t('statBestScore')],['words',t('statWordsN')],['long',t('statLongWords')],['clues',t('statCluesSolved')],
           ['sweeps',t('statSweeps')],['opponents',t('statOpponents')]]
          .map(([k,l])=>`<div><b>${s[k]||0}</b><small>${l}</small></div>`).join('')}
      </div>

      <div class="sub" style="margin-top:18px">${t('titlesHeader')}</div>
      <div class="titles">
        <button class="tsel${PROF.title===''?' on':''}" onclick="profSetTitle('')">${t('noneTitleBtn')}</button>
        ${titles.map(tt=>`<button class="tsel${PROF.title===tt.label?' on':''}"
             onclick="profSetTitle('${tt.label}')">${tt.label}</button>`).join('')
          || `<span class="sub">${t('winTrophyHint')}</span>`}
      </div>

      <div class="sub" style="margin-top:18px">${t('trophiesHeader')}</div>
      <div class="trophies">
        ${TROPHIES.map(tr=>{
          const have=tierOf(tr), v=s[tr.stat]||0;
          const next=tr.tiers[have+1];
          const pct = next ? Math.min(100, Math.round(v/next*100)) : 100;
          return `<div class="trow">
            <div class="thead">
              <span><b>${trophyName(tr)}</b> <small>${trophyDesc(tr)}</small></span>
              <span class="pips">${tr.tiers.map((n,i)=>
                `<i class="${i<=have?'lit '+TIER_NAME[i]:''}" title="${trophyTitle(tr,i)} · ${n}"></i>`).join('')}</span>
            </div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <div class="tfoot">${next ? `${v} / ${next}` : `${v} · complete`}</div>
          </div>`;
        }).join('')}
      </div>

      <div class="sub" style="margin-top:20px">${t('moveProfile')}</div>
      <div class="gorow">
        <button onclick="profShowCode()">${t('exportBtn')}</button>
        <button onclick="profAskCode()">${t('importBtn')}</button>
      </div>
      <div id="pcode"></div>

      <div style="margin-top:20px"><button onclick="raceSetup()">${t('raceBack')}</button></div>
    </div>`;
}

function profSetTitle(title){ profLoad(); PROF.title=title; profSave(); raceProfile(); }

function profShowCode(){
  $('pcode').innerHTML=`<div class="share" id="pex">${profExport()}</div>
    <button onclick="navigator.clipboard.writeText($('pex').textContent);this.textContent='${t('copiedText')}'">${t('copyCodeBtn')}</button>
    <div class="sub">${t('pasteHint')}</div>`;
}
function profAskCode(){
  $('pcode').innerHTML=`<div class="field"><label>${t('pasteCodeLabel')}</label>
    <input id="pin" style="width:88%;letter-spacing:0;font-size:12px"></div>
    <button onclick="profDoImport()">${t('loadCodeBtn')}</button>
    <div class="sub" style="color:var(--bad)" id="pinerr"></div>`;
}
function profDoImport(){
  if(profImport($('pin').value)){ raceProfile(); }
  else $('pinerr').textContent=t('codeBadFormat');
}

function raceKind(){ return [...$('rkind').children].find(b=>b.className==='on').dataset.k; }
function raceMode(){ return [...$('rmode').children].find(b=>b.className==='on').dataset.m; }

async function raceGo(){
  localStorage.setItem('vocap-name', ($('rname').value||'player').trim() || 'player');
  const kind=raceKind(), code=($('rcode').value||'').trim().toUpperCase() || newCode();
  if(kind==='solo') return raceStart(raceMode());

  const btn=$('rgo'); btn.textContent=t('openingRoom'); btn.disabled=true;
  const r=await netHost(code, kind==='duel'?MAX_DUEL:MAX_PARTY);
  btn.disabled=false; btn.textContent=t('startLower');
  if(r.error){
    $('rerr').textContent = r.error + t('raceErrSuffix');
    return setTimeout(()=>raceStart(raceMode()), 1400);
  }
  raceLobby(code, raceMode());
}

function raceLobby(code, mode){
  const label = {t120:t('opt2min'),t180:t('opt3min'),t300:t('opt5min'),p300:t('optTo300'),p500:t('optTo500')}[mode];
  $('race').innerHTML=`
    <div class="sheet">
      <div class="sub">${t('waitingRoom')}</div>
      <h2>${code}</h2>
      <div class="sub">${t('lobbyNote')}${label}.</div>
      <div class="linkbox">
        <div class="sub" style="margin:0 0 5px">${t('shareLinkNote')}</div>
        <code id="rlink">${raceLink(code)}</code>
        <div style="margin-top:7px">
          <button onclick="navigator.clipboard.writeText($('rlink').textContent);this.textContent='${t('copiedText')}'">${t('copyLinkBtn')}</button>
        </div>
      </div>
      <div id="rroster" class="roster"></div>
      <div class="sub" id="rcount"></div>
      <button class="go" onclick="raceHostStart('${mode}')">${t('startTheRaceBtn')}</button>
      <div style="margin-top:14px"><button onclick="netLeave();raceSetup()">${t('cancelBtn')}</button></div>
    </div>`;
  renderRoster();
}

function raceHostStart(mode){
  if(!NET || !NET.isHost) return;      // only the host may begin
  // reset everyone to zero so a rematch does not inherit the last race
  NET.locked = true;                 // no more joiners from here
  NET.podium = [];
  NET.roster = NET.roster.map(r=>({id:r.id, name:r.name, score:0, words:0, done:false}));
  netBroadcast({t:'start', mode});
  netBroadcast({t:'roster', roster:NET.roster});
  raceStart(mode, true);
  netHeartbeat();
}

/* Without this the board only moves when somebody scores, so a quiet minute
   looks like a broken connection. Two seconds is plenty for ten players. */
function netHeartbeat(){
  if(!NET || !NET.isHost) return;
  netBroadcast({t:'roster', roster:NET.roster});
  renderRoster();
  if(R && !R.over) setTimeout(netHeartbeat, 2000);
}

/* Joining is its own screen. Reusing the host's code box meant typing your
   friend's code into a field labelled "your room code", which read as though
   you were about to host with it. */
function raceJoinScreen(prefill){
  netLeave();
  $('race').innerHTML=`
    <div class="sheet">
      <h2>${t('joinTitle')}</h2>
      <div class="sub">${t('joinIntro')}</div>

      <div class="field">
        <label>${t('yourName')}</label>
        <input id="jname" value="${esc(netName())}" maxlength="14" style="letter-spacing:1px">
      </div>

      <div class="field">
        <label>${t('theirRoomCode')}</label>
        <input id="jcode" value="${prefill||''}" maxlength="8" placeholder="ABC12">
      </div>

      <div class="gorow">
        <button class="go" id="jgo" onclick="raceJoinGo()">${t('joinBtn')}</button>
      </div>
      <div class="sub" id="jerr" style="color:var(--bad);margin-top:10px"></div>
      <div style="margin-top:16px"><button onclick="raceSetup()">${t('raceBack')}</button></div>
    </div>`;
  const f=$('jcode'); if(f && !prefill) f.focus();
  if(f) f.onkeydown=e=>{ if(e.key==='Enter') raceJoinGo(); };
}

async function raceJoinGo(){
  const code=($('jcode').value||'').trim().toUpperCase();
  if(!code) { $('jerr').textContent=t('typeCodeErr'); return; }
  const jb=$('jgo'); jb.textContent=t('connectingBtn'); jb.disabled=true;
  localStorage.setItem('vocap-name', ($('jname').value||'player').trim() || 'player');
  $('jerr').textContent='';
  const r=await netJoin(code);
  jb.textContent=t('joinBtn'); jb.disabled=false;
  if(r.error){ $('jerr').textContent=r.error; return; }
  $('race').innerHTML=`
    <div class="sheet">
      <div class="sub">${t('waitingRoom')}</div>
      <h2>${code}</h2>
      <div class="sub">${t('youAreIn')}</div>
      <div id="rroster" class="roster"></div>
      <div class="sub" id="rcount"></div>
      <div class="waitdot">${t('waitingHost')}</div>
      <div style="margin-top:14px"><button onclick="netLeave();raceJoinScreen()">${t('leaveBtn')}</button></div>
    </div>`;
  renderRoster();
}

function raceStart(mode, online){
  const code = (NET && NET.code) || ($('rcode') ? ($('rcode').value||'').trim().toUpperCase() : '') || newCode();
  R={ code, mode, online:!!online,
      limit: mode[0]==='t' ? +mode.slice(1) : 0,
      target: mode[0]==='p' ? +mode.slice(1) : 0,
      round:0, letters:[], clues:[],
      used:new Set(), found:[], score:0,
      nLong:0, nClues:0, nSweeps:0, roundClues:0,
      building:[], started:Date.now(), over:false };
  const first = raceBuild(R.code, 0, RACE_TILES());
  R.letters = first.letters; R.clues = first.clues;
  raceRender();
  raceTick();
}

function raceTick(){
  if(!R || R.over) return;
  const el=$('rclock'); if(!el) return;

  /* Fresh letters on a fixed cadence. The round number is folded into the
     seed rather than taken from the clock, so two players who started a few
     seconds apart still see identical trays. */
  const elapsed = Math.floor((Date.now()-R.started)/1000);
  const round = Math.floor(elapsed / RACE_ROUND);
  if(round !== R.round){
    R.round = round;
    const nx = raceBuild(R.code, round, RACE_TILES());
    R.letters = nx.letters; R.clues = nx.clues;
    R.roundClues = 0;
    R.building = [];
    raceTray(); raceClueBar();
    raceFlash(t('flashFreshLetters'));
  }
  const nextIn = RACE_ROUND - (elapsed % RACE_ROUND);
  const nx=$('rnext');
  if(nx) nx.textContent = `${t('newLettersIn')}${Math.floor(nextIn/60)}:${String(nextIn%60).padStart(2,'0')}`;

  if(R.limit){
    const left=Math.max(0, R.limit-Math.floor((Date.now()-R.started)/1000));
    el.textContent=`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;
    el.className = 'clock' + (left<=15?' low':'');
    if(left<=0) return raceEnd();
  }else{
    const up=Math.floor((Date.now()-R.started)/1000);
    el.textContent=`${Math.floor(up/60)}:${String(up%60).padStart(2,'0')}`;
    el.className='clock';
  }
  setTimeout(raceTick,250);
}

function raceRender(){
  const goal = R.limit ? t('firstToTimeOut') : `${t('firstToPointsPre')}${R.target}${t('firstToPointsPost')}`;
  $('race').innerHTML=`
    <div class="sheet">
      <div class="sub">${t('codeLabel')} <b>${R.code}</b> · ${goal}</div>
      <div id="rclock" class="clock">–</div>
      <div class="tally"><b id="rscore">${R.score}</b> ${t('pointsLabel')} · <b>${R.found.length}</b> ${t('wordsLabelPlain')}</div>
      <div class="tally" id="rnext" style="font-size:12px"></div>
      <div id="rroster" class="roster"></div>
      <div class="trayrow">
        <div id="rtray" class="tray racetray"></div>
      </div>
      <div id="rclues"></div>
      <div id="rword" class="wordtray"></div>
      <div class="playrow">
        <button class="psubmit" onclick="raceSubmit()">${t('submit')}</button>
        <button onclick="R.building=[];raceTray()">${t('clear')}</button>
      </div>
      <div class="quitrow">
        <button class="quit" onclick="raceQuitAsk()">${t('leaveRaceBtn')}</button>
      </div>
      <div id="rfound" class="found"></div>
    </div>`;
  raceTray(); raceClueBar(); renderRoster();
}

/* Solving a clue is worth double, so hunting the targets beats grinding
   short words - which is what makes it a race rather than a typing test. */
function raceClueBar(){
  const el=$('rclues'); if(!el) return;
  /* Both languages, always. A room may hold Thai and English speakers at once,
     and everyone must be able to read the same clue. */
  el.innerHTML = R.clues.map(w=>{
    const got = R.used.has(w.spell);
    /* In the Thai game the clue is already Thai and the answer is Thai, so
       there is no second language to show. */
    const th  = GAME==='th' ? '' : (w.translations?.th?.definition || '');
    if(got) return `<div class="clueline done">✔ <b>${w.word}</b> — ${t('solved')}</div>`;
    return `<div class="clueline">🔎 ${w.definition}`
         + `<span class="x2">×2</span>`
         + (th?`<div class="cl-th">${th}</div>`:'')
         + `<div class="cl-n">${w.letters} ${t('lettersN')}</div></div>`;
  }).join('');
}

function raceTray(){
  const used={};
  R.building.forEach(b=>{ if(b.from>=0) used[b.from]=true; });
  $('rtray').innerHTML = R.letters.map((ch,i)=>
    `<div class="slot filled ${used[i]?'used':''}" onclick="racePick(${i})">${tileGlyph(ch)}</div>`).join('');

  /* Thai composes only in a text run, so the word being built is written out
     rather than laid out as tiles - the same reason the solo tray does it. */
  const s=R.building.map(b=>b.ch).join('');
  const w=$('rword');
  if(GAME==='th'){
    w.className='wordtray thai';
    w.innerHTML = s ? `<span class="thword">${s}</span>`
                    : `<span class="hintline">${t('tapAbove')}</span>`;
  }else{
    w.className='wordtray';
    w.innerHTML = R.building.length
      ? R.building.map(b=>`<div class="slot filled">${b.ch}</div>`).join('')
      : `<span class="hintline">${t('tapAbove')}</span>`;
  }

}

function racePick(i){
  if(R.building.some(b=>b.from===i)) return;
  R.building.push({ch:R.letters[i],from:i}); raceTray();
}

function raceSubmit(){
  if(!R || R.over) return;
  if(R.target && R.score>=R.target) return;   // you are on the podium; wait it out
  const word = GAME==='th' ? R.building.map(b=>b.ch).join('')
                           : R.building.map(b=>b.ch).join('').toLowerCase();
  R.building=[];
  if(word.length<3) return raceTray();
  if(R.used.has(word)) { raceFlash(t('flashAlreadyFound')); return raceTray(); }
  const known = BANK_ALL.some(w=>w.spell===word) || (DEFS && word in DEFS);
  if(!known) { raceFlash(t('flashNotAWord')); return raceTray(); }
  R.used.add(word);
  const isClue = R.clues.some(c=>c.spell===word);
  if(word.length>=8) R.nLong++;
  if(isClue){
    R.nClues++; R.roundClues++;
    if(R.roundClues===R.clues.length){ R.nSweeps++; raceFlash(t('flashSweep')); }
  }
  const pts = sparksFor(word.length) * (isClue?2:1);
  R.score+=pts; R.found.push({word,pts});
  $('rscore').textContent=R.score;
  $('rfound').innerHTML=R.found.slice().reverse()
      .map(f=>`<span>${f.word} <b style="color:var(--glow)">+${f.pts}</b></span>`).join('');
  raceTray(); raceClueBar(); netSendScore();
  if(isClue) raceFlash(t('flashClueDouble'));
  if(R.target && R.score>=R.target) raceEnd();
}

/* One confirmation, because leaving a room mid-race cannot be undone. */
function racePodiumNote(){
  const el=$('rnext'); if(!el || !NET || !NET.podium) return;
  const p=NET.podium;
  if(!p.length) return;
  const need=Math.min(3, Math.max(1, NET.roster.length));
  el.innerHTML = p.map(x=>`${['🥇','🥈','🥉'][x.place-1]||''} ${esc(x.name)}`).join(' · ')
               + ` <span style="opacity:.6">— ${p.length}/${need}${t('placesFilledSuffix')}</span>`;
}

function raceQuitAsk(){
  const b=document.querySelector('#race .quit');
  if(!b) return;
  if(b.dataset.armed){ raceEnd(); return; }
  b.dataset.armed='1';
  b.textContent=t('reallyLeaveBtn');
  b.style.opacity='1'; b.style.color='var(--bad)';
  setTimeout(()=>{ if(!b.isConnected) return;
    delete b.dataset.armed; b.textContent=t('leaveRaceBtn');
    b.style.opacity=''; b.style.color=''; }, 4000);
}

function raceFlash(msg){
  const el=$('rfound'); if(!el) return;
  const n=document.createElement('span');
  n.textContent=msg; n.style.opacity='.6';
  el.prepend(n); setTimeout(()=>n.remove(),1200);
}

function raceEnd(){
  if(!R || R.over) return;
  R.over=true;
  netSendScore();

  /* Log it before drawing the result, so the screen can announce anything
     that unlocked. Solo races count too - you are still playing. */
  const rows = NET ? NET.roster.slice().sort((a,b)=>b.score-a.score) : [];
  const won  = NET ? (rows.length>1 && rows[0] && rows[0].id===NET.myId) : false;
  const unlocked = profRecord({
    score:R.score, words:R.found.length, long:R.nLong, clues:R.nClues,
    sweeps:R.nSweeps, won, ranked: !!(NET && rows.length>1),
    opponents: rows.filter(r=>r.id!==(NET&&NET.myId)).map(r=>r.name)
  });
  submitRaceScore(R.score, R.found.length);
  const secs=Math.floor((Date.now()-R.started)/1000);
  const best=R.found.slice().sort((a,b)=>b.pts-a.pts)[0];
  const share=`VOCAP ${t('raceTitle')} · ${R.code}\n${R.score} ${t('pointsLabel')} · ${R.found.length} ${t('wordsLabelPlain')}`
            + `\n${t('shareBest')}: ${best?best.word.toUpperCase()+' +'+best.pts:'—'}`
            + `\n${t('shareTime')}: ${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`
            + `\n${t('shareTrays')}: ${R.round+1}`;
  $('race').innerHTML=`
    <div class="sheet">
      ${NET ? `<div class="sub">${t('finalStandings')}</div><div id="rboard" class="board"></div>`
            : `<h2>${R.score}</h2><div class="sub">${R.found.length} ${t('wordsLabelPlain')} · ${t('codeLabel')} ${R.code}</div>`}

      <div class="sub" style="margin-top:14px">${t('yourWords')}</div>
      <div class="found">${R.found.slice().sort((a,b)=>b.pts-a.pts)
          .map(f=>`<span>${f.word} <b style="color:var(--glow)">+${f.pts}</b></span>`).join('')
          || `<span style="opacity:.5">${t('noneThisTime')}</span>`}</div>

      ${unlocked.length ? `<div class="unlocks">${unlocked.map(u=>
          `<div class="unlock"><span class="tro ${TIER_NAME[u.k]}">🏆</span>
             <span><b>${trophyTitle(u.t,u.k)}</b><small>${trophyName(u.t)} · ${tierLabel(u.k)}
             · +${TIER_LAUREL[u.k]} ${t('laurelsWord')}</small></span></div>`).join('')}</div>` : ''}
      <div class="laurelrow">+${(NET&&rows.length>1&&rows[0]&&rows[0].id===NET.myId)?30:10} ${t('laurelsWord')}
        <span>· ${PROF.laurels} ${t('totalWord')}</span></div>
      <div class="share">${share}</div>
      <button onclick="navigator.clipboard.writeText(${JSON.stringify(share)});this.textContent='${t('copiedText')}'">${t('copyResultBtn')}</button>

      <div style="margin-top:18px">
        <button onclick="raceSetup()">${t('raceAgainBtn')}</button>
        <button onclick="closeRace()">${t('raceBackToGame')}</button>
      </div>
    </div>`;
  renderBoard();
  // keep the standings updating while slower players finish
  if(NET) { const tick=setInterval(()=>{ if($('rboard')) renderBoard(); else clearInterval(tick); }, 1000); }
}

/* The finishing table: everyone in order, with the gap to first so a close
   race reads as close. */
function renderBoard(){
  const el=$('rboard'); if(!el || !NET) return;
  const rows=NET.roster.slice().sort((a,b)=>b.score-a.score);
  const top=rows.length?rows[0].score:0;
  const medal=['🥇','🥈','🥉'];
  el.innerHTML = rows.map((r,i)=>{
    const gap = i===0 ? '' : `−${top-r.score}`;
    return `<div class="brow${r.name===netName()?' me':''}">
      <span class="pos">${medal[i]||(i+1)+'.'}</span>
      <span class="nm">${esc(r.name)}${r.title?`<em>${esc(r.title)}</em>`:''}${r.done?'':` <i>${t('stillGoing')}</i>`}</span>
      <span class="pts"><b>${r.score}</b><small>${r.words}w ${gap}</small></span>
    </div>`;
  }).join('');
}

/* A link like  .../?race=KTQ7M  opens straight into the join screen with the
   code already filled in. On stream you paste one link and nobody has to type
   anything or install anything - the web build is the whole game. */
(function deepLink(){
  const code=new URLSearchParams(location.search).get('race');
  if(!code) return;
  setTimeout(()=>{
    $('race').className='show';
    raceJoinScreen(code.toUpperCase());
  }, 400);
})();

/* typing works in a race too */
document.addEventListener('keydown',e=>{
  if(!R || R.over || $('race').className!=='show') return;
  if(e.key==='Enter'){ raceSubmit(); return; }
  if(e.key==='Escape'){ R.building=[]; raceTray(); return; }
  if(e.key==='Backspace'){ R.building.pop(); raceTray(); return; }
  /* Thai is caseless, so leave the key as typed; lowercasing Latin only. */
  const ch = GAME==='th' ? e.key : e.key.toLowerCase();
  const okKey = GAME==='th' ? /^[\u0E00-\u0E7F]$/.test(ch) : /^[a-z]$/.test(ch);
  if(!okKey) return;
  const i=R.letters.findIndex((L,idx)=>L===ch && !R.building.some(b=>b.from===idx));
  if(i>=0){ R.building.push({ch,from:i}); raceTray(); }
}, true);

/* typing works in puzzle mode too - same claim-a-matching-tile pattern the
   main tray already uses for its own keyboard input. */
document.addEventListener('keydown',e=>{
  if(!PZ || $('puzzle').className!=='show') return;
  if(e.key==='Enter'){ submitPuzzle(); return; }
  if(e.key==='Escape'){ puzzleClear(); return; }
  if(e.key==='Backspace'){
    const b=PZ.building.pop();
    if(b && b.from>=0) PZ.used[b.from]=false;
    renderPuzzle();
    return;
  }
  const ch = GAME==='th' ? e.key : e.key.toLowerCase();
  const okKey = GAME==='th' ? /^[\u0E00-\u0E7F]$/.test(ch) : /^[a-z]$/.test(ch);
  if(!okKey) return;
  const i = puzzleClaimSlot(ch);
  if(i!==null) puzzlePick(i);
}, true);

/* ---------------- input ---------------- */
document.addEventListener('keydown',e=>{
  if($('race').className==='show' || $('puzzle').className==='show') return;
  if(($('overlay').className==='show'||$('popup').className==='show') && e.key!=='Escape') return;
  // A focused button would otherwise fire on Enter or Space as well.
  if(document.activeElement && document.activeElement.tagName==='BUTTON'
     && document.activeElement.id!=='submit') dropFocus();
  noteActivity();
  if(e.key==='Enter'){submit();return}
  if(e.key==='Escape'){
    if($('popup').className==='show'){closePop();return}
    if($('overlay').className==='show'){closePanel();return}
    building=[];renderTray();renderWordTray();return}
  if(e.key==='Backspace'){building.pop()}
  else if(e.key===' '){building.push({ch:' ',from:null});e.preventDefault()}   // free space
  else if(GAME==='th' ? /^[฀-๿]$/.test(e.key) : /^[a-zA-Z']$/.test(e.key)){
    const ch = GAME==='th' ? e.key : e.key.toLowerCase();
    const slot=claimSlot(ch);
    if(slot===null){flash(`no free "${tileGlyph(ch)}" in the tray`,'bad');return}
    speakLetter(ch);
    building.push({ch,from:slot});
  }
  else return;
  $('card').className='';
  flash('');
  renderTray(); renderWordTray();
});
for(const id of ['speed','ivl','skip','lang','say','sayl','book','dictbtn','promote','reset','clear','submit',
                  'pzSubmit','pzClear','pzShuffle','pzNext','pzPlay','pzBack','pzStageBack']){
  const b=$(id); if(b) b.addEventListener('click',()=>setTimeout(dropFocus,0));
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) lastTick=Math.min(lastTick,Date.now()); });
$('c-close').onclick=()=>{$('card').className='';};
$('say').onclick=()=>{ sayWords=!sayWords; applyUI(); };
$('sayl').onclick=()=>{ sayLetters=!sayLetters; applyUI(); };
$('submit').onclick=()=>submit();
$('clear').onclick=()=>{building=[];renderTray();renderWordTray()};
/* 5 / 10 / 20 minutes: some players want a slow ambient trickle, others a
   livelier tray. Idle-pause still protects anyone who steps away. */
const IVLS=[5,10,20]; let ivlIdx=0;
$('ivl').onclick=()=>{
  ivlIdx=(ivlIdx+1)%IVLS.length;
  INTERVAL_MS=IVLS[ivlIdx]*60*1000;
  $('ivl').textContent='⏱ '+IVLS[ivlIdx]+' min';
  scheduleDrop();
};
/* Fast mode used to drip a letter every two seconds, which is still waiting.
   Filling the tray outright is what people actually want it for, and turning
   itself off afterwards stops it quietly ruining the next run. */
function fillTrayNow(){
  while(dropped < order.length){
    pool.push(order[dropped]); dropped++;
  }
  renderTray(); renderClue(); save();
  flash('tray filled','good');
  scheduleDrop();
}
/* The interface follows the game. A Thai player picked the Thai game, so
   asking them again which language the menus should be in is noise. */
function syncUILang(){
  UI = GAME==='th' ? 'th' : 'en';
}

/* Modes and language both live behind one small trigger in the corner,
   rather than scattered across the main screen. The next mode this game
   gets is a new card here, not a new button somewhere in the tray. */
const MODES = [
  {key:'classic',   icon:'🌱', nmKey:'modeClassic',   descKey:'modeClassicDesc'},
  {key:'anagram',   icon:'🔀', nmKey:'modeAnagram',   descKey:'modeAnagramDesc'},
  {key:'listening', icon:'🎧', nmKey:'modeListening', descKey:'modeListeningDesc'},
  {key:'puzzle',    icon:'🧩', nmKey:'modePuzzle',    descKey:'modePuzzleDesc'},
  {key:'hangman',   icon:'🎨', nmKey:'modeHangman',   descKey:'modeHangmanDesc'},
  {key:'race',      icon:'🏁', nmKey:'modeRace',      descKey:'modeRaceDesc'},
];
const LANGS = [
  {key:'en', nm:'English',  file:'index.html'},
  {key:'th', nm:'ภาษาไทย',  file:'index-th.html'},
];
function renderModesTrigger(){
  const el=$('gamepill'); if(!el) return;
  const here = LANGS.find(l=>l.key===GAME) || LANGS[0];
  el.innerHTML = `<button onclick="showLanguageSplash()">☰ ${here.nm}</button>`;
}
renderModesTrigger();

/* The language choice happens once, up front, on its own screen - not as a
   pill living inside the modes menu. Each language then gets its own modes
   menu with nothing in it to switch mid-browse; the corner button is the
   one way back to the language choice if a player wants the other game. */
function showLanguageSplash(){
  const cards = LANGS.map(l=>
    `<div class="modecard langcard" onclick="chooseLanguage('${l.key}')"><b>${l.nm}</b></div>`
  ).join('');
  openPanel(`<div class="phead"><div><h2>Choose a language · เลือกภาษา</h2></div></div>
      <div class="modegrid">${cards}</div>`);
}
function chooseLanguage(lang){
  if(lang===GAME){ showModeMenu(); return; }
  const target = (LANGS.find(l=>l.key===lang)||LANGS[0]).file;
  location.href = target+'?open=modes';
}

function showModeMenu(){
  const cards = MODES.map(m=>{
    const here = m.key==='classic';
    return `<div class="modecard${here?' here':''}" onclick="goToMode('${m.key}')">
      <span class="ic">${m.icon}</span>
      <b>${t(m.nmKey)}</b>
      <span>${here?t('youAreHere'):''}${t(m.descKey)}</span>
    </div>`;
  }).join('');
  openPanel(`<div class="phead"><div><h2>${t('modes')}</h2>
      <div class="sub">${t('modesSub')}</div></div>
      <button onclick="closePanel()">${t('close')}</button></div>
      <div class="modegrid">${cards}</div>`);
}
function goToMode(mode){
  closePanel();
  if(mode==='race') openRace();
  else if(mode==='anagram' || mode==='listening' || mode==='puzzle') openPuzzle(mode);
  else if(mode==='hangman') openHangman();
}

/* ═══════════════════ PUZZLE MODES (Anagram / Listening) ═══════════════════
   Both reuse the tray-and-word-bar mechanics Classic already has, just
   without a drip: every letter the word needs is already in the pool,
   scrambled. The only difference between them is the clue - a definition
   for Anagram, audio only for Listening - and both feed the same
   collection, sparks and tray growth as Classic, since they are different
   ways into the same words, not a separate economy the way Race
   deliberately is. */
let PZ = null;   // {kind, w, order, used, building} or null while closed

function pickPuzzleWord(){
  const [lo,hi] = PLAN[Math.floor(Math.random()*PLAN.length)];
  const fresh  = BANK.filter(w=>!seen.has(w.id) && w.letters>=lo && w.letters<=hi);
  const unseen = BANK.filter(w=>!seen.has(w.id));
  const banded = BANK.filter(w=>w.letters>=lo && w.letters<=hi);
  const pool = fresh.length ? fresh : unseen.length ? unseen : banded.length ? banded : BANK;
  return pool[Math.floor(Math.random()*pool.length)];
}

/* ═══════════════════ PUZZLE: staged difficulty ═══════════════════
   Easy/Medium/Hard as their own deliberate mode rather than a setting
   Classic quietly inherited - clearing a stage's word count unlocks the
   next one, and each stage has its own letter-length band AND its own
   noise count (extra decoy tiles among the real ones), reusing the same
   noiseLetters() the drip already relies on. Difficulty used to also be
   capped by whatever tray size Classic had already grown to; a stage
   defines its own tray instead, so Hard is reachable from a first visit. */
const PUZZLE_STAGES = [
  {key:'easy',   icon:'🌱', nmKey:'stageEasy',   band:[3,5],   noise:2, need:8},
  {key:'medium', icon:'🧭', nmKey:'stageMedium', band:[6,9],   noise:4, need:12},
  {key:'hard',   icon:'🎓', nmKey:'stageHard',   band:[10,15], noise:6, need:18},
];
function loadPuzzleProgress(){
  try{ const d=JSON.parse(localStorage.getItem('vocap-puzzle-progress'));
       if(d) return d; }catch(e){}
  return {solved:{}, cleared:{}};
}
let PUZPROG = loadPuzzleProgress();
function savePuzzleProgress(){ localStorage.setItem('vocap-puzzle-progress', JSON.stringify(PUZPROG)); }
function stageUnlocked(key){
  const i = PUZZLE_STAGES.findIndex(s=>s.key===key);
  return i<=0 || !!PUZPROG.cleared[PUZZLE_STAGES[i-1].key];
}
function pickStageWord(stage){
  const [lo,hi] = stage.band;
  const fresh  = BANK.filter(w=>!seen.has(w.id) && w.letters>=lo && w.letters<=hi);
  const banded = BANK.filter(w=>w.letters>=lo && w.letters<=hi);
  const pool = fresh.length ? fresh : banded.length ? banded : BANK;
  return pool[Math.floor(Math.random()*pool.length)];
}

function openPuzzle(kind){
  closePanel();
  PZ = {kind, w:null, order:[], used:[], building:[], stage:null, thaiBestEffort:false};
  $('puzzle').className='show';
  if(kind==='puzzle'){
    $('pzTitle').textContent=t('puzzleTitle');
    $('pzSub').textContent=t('puzzleSub');
    showPuzzleStages();
  } else if(kind==='listening' && GAME==='th' && !hasThaiVoice()){
    /* No Thai voice means the pronunciation may come out wrong rather
       than not at all - a "play anyway" choice belongs to the player,
       not a decision made for them, so this offers it rather than
       blocking the mode outright. */
    $('pzTitle').textContent = t('listeningTitle');
    $('pzSub').textContent   = t('listeningSub');
    showListeningUnavailable();
  } else {
    $('pzTitle').textContent = kind==='anagram' ? t('anagramTitle') : t('listeningTitle');
    $('pzSub').textContent   = kind==='anagram' ? t('anagramSub')   : t('listeningSub');
    $('pzArea').style.display='flex'; $('pzStages').style.display='none';
    $('pzStageBack').style.display='none';
    puzzleNext();
  }
}
function showListeningUnavailable(){
  $('pzArea').style.display='none';
  $('pzStageBack').style.display='none';
  const el=$('pzStages'); el.style.display='flex';
  el.innerHTML = `<div class="msg bad">${t('noThaiVoice')}</div>
    <div class="row">
      <button class="primary" onclick="listeningPlayAnyway()">${t('playAnyway')}</button>
      <button onclick="closePuzzle()">${t('backToGame')}</button>
    </div>`;
}
function listeningPlayAnyway(){
  if(!PZ) return;
  PZ.thaiBestEffort = true;
  $('pzArea').style.display='flex'; $('pzStages').style.display='none';
  $('pzStageBack').style.display='none';
  puzzleNext();
}
function closePuzzle(){ $('puzzle').className=''; PZ=null; renderTray(); renderClue(); }

/* the stage picker replaces the play area entirely rather than living
   alongside it, so there is only ever one thing to look at */
function showPuzzleStages(){
  if(PZ) PZ.stage=null;
  $('pzArea').style.display='none';
  const el=$('pzStages'); el.style.display='flex';
  const cards = PUZZLE_STAGES.map(s=>{
    const unlocked = stageUnlocked(s.key), cleared = !!PUZPROG.cleared[s.key];
    const solved = Math.min(PUZPROG.solved[s.key]||0, s.need);
    return `<div class="modecard${!unlocked?' locked':''}"
                 ${unlocked?`onclick="startPuzzleStage('${s.key}')"`:''}>
      <span class="ic">${unlocked?s.icon:'🔒'}</span>
      <b>${t(s.nmKey)}${cleared?t('clearedSuffix'):''}</b>
      <span>${unlocked ? `${solved}/${s.need} ${t('solved')}` : t('lockedStage')}</span>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="modegrid">${cards}</div>`;
}
function startPuzzleStage(key){
  if(!stageUnlocked(key)) return;
  PZ.stage = key;
  $('pzStages').style.display='none';
  $('pzArea').style.display='flex';
  $('pzStageBack').style.display='block';
  puzzleNext();
}

function puzzleNext(){
  if(PZ.kind==='puzzle'){
    const stage = PUZZLE_STAGES.find(s=>s.key===PZ.stage);
    PZ.w = pickStageWord(stage);
    const noise = noiseLetters(count(PZ.w.spell), stage.noise);
    PZ.order = [...clusterSpell(PZ.w.spell), ...noise].sort(()=>Math.random()-.5);
  } else {
    PZ.w = pickPuzzleWord();
    PZ.order = clusterSpell(PZ.w.spell).sort(()=>Math.random()-.5);
  }
  PZ.used = PZ.order.map(()=>false);
  PZ.building = [];
  $('pzMsg').textContent=''; $('pzMsg').className='msg';
  $('pzCard').className=''; $('pzCard').innerHTML='';
  $('pzNext').textContent=t('newWord'); $('pzNext').classList.remove('primary');
  if(PZ.kind==='puzzle'){
    const stage = PUZZLE_STAGES.find(s=>s.key===PZ.stage);
    const solved = Math.min(PUZPROG.solved[PZ.stage]||0, stage.need);
    $('pzSub').textContent = `${t(stage.nmKey)} · ${solved}/${stage.need} ${t('solved')}`;
  }
  renderPuzzle();
  /* This bypasses the sayWords toggle on purpose: for Listening mode audio
     IS the clue, not a bonus, so muting word-speech elsewhere must not also
     silence the one mode where silence means "no clue at all". */
  if(PZ.kind==='listening'){
    if(GAME==='th') speakThaiWord(PZ.w.word, PZ.thaiBestEffort);
    else speak(PZ.w.word,{rate:0.8});
  }
}

function puzzlePick(i){
  if(!PZ || PZ.used[i]) return;
  PZ.used[i]=true;
  PZ.building.push({ch:PZ.order[i], from:i});
  speakLetter(PZ.order[i]);
  renderPuzzle();
}
function puzzleClaimSlot(ch){
  for(let i=0;i<PZ.order.length;i++) if(!PZ.used[i] && PZ.order[i][0]===ch) return i;
  return null;
}
function puzzleClear(){
  if(!PZ) return;
  PZ.used = PZ.order.map(()=>false);
  PZ.building = [];
  renderPuzzle();
}
function puzzleShuffle(){
  if(!PZ) return;
  PZ.order = [...PZ.w.spell].sort(()=>Math.random()-.5);
  PZ.used = PZ.order.map(()=>false);
  PZ.building = [];
  renderPuzzle();
}

function renderPuzzle(){
  if(!PZ) return;
  const w = PZ.w;

  $('pzTray').innerHTML = PZ.order.map((ch,i)=>
    `<div class="slot filled${PZ.used[i]?' used':''}" onclick="puzzlePick(${i})">${tileGlyph(ch)}</div>`).join('');

  const s = PZ.building.map(b=>b.ch).join('');
  const barEl = $('pzWordbar');
  if(GAME==='th'){
    barEl.className='wordtray thai';
    barEl.innerHTML = s ? `<span class="thword">${s}</span>` : `<span class="hintline">${t('tapAbove')}</span>`;
  } else {
    barEl.className='wordtray';
    barEl.innerHTML = PZ.building.length
      ? PZ.building.map(b=>`<div class="slot filled">${b.ch}</div>`).join('')
      : `<span class="hintline">${t('tapAbove')}</span>`;
  }

  const clueEl = $('pzClue');
  if(PZ.kind==='puzzle'){
    const th = (GAME!=='th' && lang==='th') ? (w.translations?.th?.definition||'') : '';
    clueEl.style.display='block';
    clueEl.innerHTML = `🔎 ${w.definition}` + (th?`<div class="cl-th2">${th}</div>`:'');
  } else clueEl.style.display='none';

  $('pzListenRow').style.display = PZ.kind==='listening' ? 'flex' : 'none';
}

function puzzlePlayAgain(){
  if(!PZ || PZ.kind!=='listening') return;
  if(GAME==='th') speakThaiWord(PZ.w.word, PZ.thaiBestEffort);
  else speak(PZ.w.word,{rate:0.8});
}

function submitPuzzle(){
  if(!PZ) return;
  const answer = PZ.building.map(b=>b.ch).join('');
  PZ.building=[]; PZ.used=PZ.order.map(()=>false);
  renderPuzzle();

  if(answer.length<2){ $('pzMsg').textContent=t('tooShort'); $('pzMsg').className='msg bad'; return; }
  if(answer===PZ.w.spell){ puzzleAward(PZ.w, true); return; }

  /* A different real word made from the very same tiles still counts, the
     same way Classic credits any valid word it finds in the tray - curated
     first, then the free dictionary. It does not advance the puzzle: the
     word actually asked for is still unsolved. */
  const alt = BANK.find(x=>x.spell===answer);
  if(alt){ puzzleAward(alt, false); return; }
  if(DICT.has(answer)){
    inkTally[answer]=(inkTally[answer]||0)+1;
    if(inked.has(answer)){
      sparks++; save();
      $('pzMsg').textContent=t('alreadyInked');
    } else {
      inked.add(answer); sparks+=2; save(); speakWord(answer); showDictCard(answer);
      $('pzMsg').textContent=t('inkedInDictionary');
    }
    $('pzMsg').className='msg good';
    return;
  }
  $('pzMsg').textContent=t('notQuite'); $('pzMsg').className='msg bad';
}
/* The main card (cardHTML/#card) is id-based and lives behind this
   overlay, so it stays queued for later rather than shown here - this is
   the same information, built the same way, but as its own classed markup
   so it can actually be seen while the puzzle is still open. */
function puzzleCardHTML(w,gain){
  const th = GAME==='th' ? (w.translations?.en||{})
                         : (lang==='th' ? (w.translations?.th||{}) : {});
  const tags=[w.topic,w.topic2].filter(Boolean)
      .map(t=>`<span>${TOPIC_ICON[t]||'✦'} ${t}</span>`).join('');
  /* speechSynthesis only knows English pronunciation - on the Thai page
     w.word is the Thai spelling, so the speaker plays the English side
     (englishOf) instead of trying, and failing, to say the Thai word. */
  const speakText = englishOf(w).replace(/'/g,"\\'");
  const speakBtn = speakText
    ? `<button class="speakbtn" onclick="speechSynthesis.cancel();speak('${speakText}',{rate:0.8})" title="listen">🔊</button>`
    : '';
  return `
    <div class="art">${TOPIC_ICON[w.topic]||'✦'}</div>
    <div class="body">
      <h3>${w.word} ${speakBtn}
        <span class="spark">${gain?`+${gain} ✨`:'in your collection'}</span></h3>
      <div class="th">${th.word||''}</div>
      <p>${w.definition}</p>
      <p class="thdef">${th.definition||''}</p>
      <div class="fact"><p>${w.history||''}</p><p>${th.history||''}</p></div>
      <div class="tags">${tags}</div>
    </div>`;
}
function puzzleAward(w, isTarget){
  const gain = seen.has(w.id) ? 0 : sparksFor(w.letters);
  if(seen.has(w.id)){
    sparks++; save(); speakEntry(w);
    $('pzMsg').textContent=t('alreadyInCollection');
  } else {
    sparks+=gain; seen.add(w.id); save();
    speakEntry(w); showCard(w,gain); logWord(w); checkGrowth();
    $('pzMsg').textContent=`+${gain} ✨`;
  }
  $('pzMsg').className='msg good';
  $('pzCard').innerHTML = puzzleCardHTML(w, gain);
  $('pzCard').className = 'show';
  /* The word is solved and the card is up - moving on is now the obvious
     next step, so the button that already does that (puzzleNext) becomes
     the prompt, rather than the player having to notice it on their own
     or wait out a timer. Listening used to advance on a fixed delay here;
     it read as rushed, especially with the card now actually visible to
     read. */
  if(isTarget){
    $('pzNext').textContent=t('nextWord'); $('pzNext').classList.add('primary');
  }
  if(isTarget && PZ.kind==='puzzle'){
    const stage = PUZZLE_STAGES.find(s=>s.key===PZ.stage);
    PUZPROG.solved[PZ.stage] = (PUZPROG.solved[PZ.stage]||0) + 1;
    const justCleared = PUZPROG.solved[PZ.stage] >= stage.need && !PUZPROG.cleared[PZ.stage];
    if(justCleared) PUZPROG.cleared[PZ.stage] = true;
    savePuzzleProgress();
    const solved = Math.min(PUZPROG.solved[PZ.stage], stage.need);
    $('pzSub').textContent = `${t(stage.nmKey)} · ${solved}/${stage.need} ${t('solved')}`;
    if(justCleared){
      const next = PUZZLE_STAGES[PUZZLE_STAGES.findIndex(s=>s.key===PZ.stage)+1];
      $('pzMsg').textContent = next
        ? `🎉 ${t(stage.nmKey)} ${t('stageClearedWord')} — ${t(next.nmKey)} ${t('unlockedWord')}!`
        : `🎉 ${t(stage.nmKey)} ${t('stageClearedWord')} — ${t('allStagesCleared')}`;
    }
  }
}

/* ═══════════════════ HANGMAN ═══════════════════
   A classic guess-the-letters game dressed in cosmetics instead of a
   gallows: each skin is its own small SVG scene that gets worse, one
   step at a time, as wrong guesses come in - a wilting sprout, a kite
   losing its string, a guttering lantern - rather than a fixed drawing
   of a figure on a gallows. Tone marks stay "free" here exactly as they
   already are everywhere else in this file (see FREE_MARKS/count()):
   they ride along on whichever letter they follow rather than being a
   guessable unit of their own. */
const HANGMAN_MAX_WRONG = 6;
const HANGMAN_SKINS = [
  {id:'classic', icon:'🎩', nameKey:'skinClassic', draw:skinClassic},
  {id:'sprout',  icon:'🌱', nameKey:'skinSprout',  draw:skinSprout},
  {id:'kite',    icon:'🪁', nameKey:'skinKite',    draw:skinKite},
  {id:'lantern', icon:'🏮', nameKey:'skinLantern', draw:skinLantern},
];
/* The traditional gallows-and-figure, for players who just want the
   familiar version - kept light and rounded rather than grim, and in the
   app's own terracotta rather than stark black, so it still feels like
   part of the same game as the other three. Six body parts line up
   exactly with HANGMAN_MAX_WRONG, one per wrong guess. */
function skinClassic(wrong,maxWrong){
  const ink='#dd8f65', wood='#8a6b4a', woodDark='#6b5136';
  const parts = [
    wrong>=1 ? `<circle cx="140" cy="66" r="15" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : '',
    wrong>=2 ? `<path d="M140 81 L140 128" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : '',
    wrong>=3 ? `<path d="M140 94 L114 112" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : '',
    wrong>=4 ? `<path d="M140 94 L166 112" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : '',
    wrong>=5 ? `<path d="M140 128 L118 164" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : '',
    wrong>=6 ? `<path d="M140 128 L162 164" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` : '',
  ].join('');
  return `<svg viewBox="0 0 200 200" width="180" height="180">
    <ellipse cx="100" cy="192" rx="70" ry="6" fill="#000" opacity="0.12"/>
    <path d="M40 190 L165 190" stroke="${wood}" stroke-width="7" stroke-linecap="round"/>
    <path d="M70 190 L70 24" stroke="${wood}" stroke-width="7" stroke-linecap="round"/>
    <path d="M68 24 L142 24" stroke="${wood}" stroke-width="7" stroke-linecap="round"/>
    <path d="M70 40 L92 24" stroke="${woodDark}" stroke-width="5" stroke-linecap="round"/>
    <path d="M140 24 L140 50" stroke="${woodDark}" stroke-width="4" stroke-linecap="round"/>
    ${parts}
  </svg>`;
}
function skinSprout(wrong,maxWrong){
  const p = wrong/maxWrong;
  const stemBend = p*35;
  /* Each leaf is drawn off-center from its own pivot point (cx=17, not 0)
     so rotating it sweeps the blade outward from the stem like a real
     leaf, rather than just spinning a shape in place. Tiers start at
     different base angles so a fully healthy plant reads as layered
     leaf pairs, not one overlapping blob. */
  const leaves = [0,1,2].map(i=>{
    const d = Math.min(1, Math.max(0, p*3 - i));
    const y = 126 - i*34;
    const base = 55 + i*10;
    const fill = `hsl(${102-72*d},${58-28*d}%,${40-12*d}%)`;
    const edge = `hsl(${102-72*d},${50-20*d}%,${25-8*d}%)`;
    const angL = -base-d*55, angR = base+d*55;
    const leaf = (ang)=>`<g transform="rotate(${ang})">
        <ellipse cx="16" cy="0" rx="17" ry="7" fill="${fill}" stroke="${edge}" stroke-width="1.5"/>
        <path d="M1 0 L31 0" stroke="${edge}" stroke-width="1" opacity="0.5"/>
      </g>`;
    return `<g transform="translate(100 ${y})">${leaf(angL)}${leaf(angR)}</g>`;
  }).join('');
  /* A five-petal flower loses one petal per wrong guess instead of just
     drooping in place - each fallen petal lands and stays on the pot
     rim, so the wrong-guess count is visible at a glance as much from
     what's missing above as what's piled up below. */
  const petalCount = 5, petalFill='#e8b4d8', petalEdge='#c4749f';
  const onFlower = [];
  for(let i=0;i<petalCount;i++){
    if(i<wrong) continue;
    const ang = i*(360/petalCount);
    onFlower.push(`<g transform="translate(100 58) rotate(${ang})">
      <ellipse cx="0" cy="-11" rx="6" ry="10" fill="${petalFill}" stroke="${petalEdge}" stroke-width="1"/>
    </g>`);
  }
  const flowerCenter = wrong<petalCount
    ? `<circle cx="100" cy="58" r="5" fill="#f2c94c" stroke="#c99a2e" stroke-width="1"/>` : '';
  const fallenPetals = Array.from({length:Math.min(petalCount,wrong)},(_,i)=>{
    const fx = 74+i*14, fy = 176+(i%2)*7, rot = 30+i*35;
    return `<ellipse cx="${fx}" cy="${fy}" rx="6" ry="9" fill="${petalFill}" stroke="${petalEdge}" stroke-width="1" opacity="0.85" transform="rotate(${rot} ${fx} ${fy})"/>`;
  }).join('');
  return `<svg viewBox="0 0 200 200" width="180" height="180">
    <ellipse cx="100" cy="188" rx="58" ry="7" fill="#000" opacity="0.15"/>
    <path d="M56 188 L144 188 L130 142 L70 142 Z" fill="#b5713f"/>
    <path d="M62 150 L138 150" stroke="#8a5530" stroke-width="2" opacity="0.5"/>
    <path d="M56 188 L70 142 M144 188 L130 142" stroke="#8a5530" stroke-width="2" fill="none"/>
    <path d="M100 142 Q${100+stemBend} 92 100 60" fill="none" stroke="#3f6b34" stroke-width="6" stroke-linecap="round"/>
    ${leaves}
    ${onFlower.join('')}
    ${flowerCenter}
    ${fallenPetals}
  </svg>`;
}
function skinKite(wrong,maxWrong){
  const p = wrong/maxWrong;
  const tilt = p*35, drift = p*40, snapped = wrong>=maxWrong;
  const wind = Array.from({length:Math.floor(p*4)},(_,i)=>
    `<path d="M${16+i*11} ${36+i*16} q12 -7 24 0" stroke="#9db3c8" stroke-width="2.5" fill="none" stroke-linecap="round" opacity="${0.35+0.15*i}"/>`).join('');
  const string = snapped
    ? `<path d="M100 88 L100 128" stroke="#7a6a52" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="4 7"/>`
    : `<path d="M${100+drift*0.3} ${88+drift*0.3} L100 168" stroke="#7a6a52" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${Math.max(1,7-p*6)} ${p*11}"/>`;
  return `<svg viewBox="0 0 200 200" width="180" height="180">
    <circle cx="34" cy="34" r="16" fill="#e8c060" opacity="0.85"/>
    <ellipse cx="100" cy="188" rx="20" ry="5" fill="#000" opacity="0.12"/>
    <path d="M86 172 Q100 160 114 172 L114 182 Q100 190 86 182 Z" fill="#8a6b4a"/>
    <circle cx="100" cy="176" r="10" fill="none" stroke="#6b5136" stroke-width="2"/>
    ${wind}${string}
    <g transform="translate(${100+drift} ${88-drift}) rotate(${tilt})">
      <path d="M0 -32 L22 0 L0 32 L-22 0 Z" fill="#e08165" stroke="#a4472f" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M0 -32 L11 0 L0 32 L-11 0 Z" fill="#f2a58a" opacity="0.7"/>
      <path d="M0 -32 L0 32 M-22 0 L22 0" stroke="#a4472f" stroke-width="1.5"/>
      <path d="M0 32 q-5 11 -12 13 M0 32 q5 11 12 13" stroke="#a4472f" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <circle cx="-6" cy="45" r="2.5" fill="#a4472f"/><circle cx="6" cy="45" r="2.5" fill="#a4472f"/>
    </g>
  </svg>`;
}
function skinLantern(wrong,maxWrong){
  const p = wrong/maxWrong, flameH = Math.max(2,36*(1-p)), out = wrong>=maxWrong;
  const drops = Array.from({length:Math.floor(p*7)},(_,i)=>
    `<line x1="${26+i*20}" y1="${8+(i*17)%26}" x2="${19+i*20}" y2="${30+(i*17)%26}" stroke="#7fa6c9" stroke-width="2.5" stroke-linecap="round" opacity="${0.4+0.08*i}"/>`).join('');
  return `<svg viewBox="0 0 200 200" width="180" height="180">
    <ellipse cx="100" cy="192" rx="34" ry="6" fill="#000" opacity="0.12"/>
    ${drops}
    <path d="M100 96 L100 112" stroke="#4a3a2a" stroke-width="2.5"/>
    <circle cx="100" cy="94" r="4" fill="none" stroke="#4a3a2a" stroke-width="2.5"/>
    <rect x="68" y="112" width="64" height="66" rx="10" fill="#7a5637"/>
    <rect x="68" y="112" width="64" height="10" rx="5" fill="#6b4a2f"/>
    <rect x="68" y="168" width="64" height="10" rx="5" fill="#6b4a2f"/>
    <rect x="74" y="120" width="52" height="44" rx="6" fill="#241a12"/>
    ${out ? '' : `
      <circle cx="100" cy="158" r="${22*(1-p*0.25)}" fill="#f2a44a" opacity="0.2"/>
      <path d="M100 ${160-flameH} Q113 ${160-flameH*0.5} 100 160 Q87 ${160-flameH*0.5} 100 ${160-flameH}" fill="#f2a44a"/>
      <path d="M100 ${160-flameH*0.55} Q106 ${160-flameH*0.3} 100 160 Q94 ${160-flameH*0.3} 100 ${160-flameH*0.55}" fill="#ffd58a"/>
    `}
  </svg>`;
}
function loadHangmanSkin(){
  const id = localStorage.getItem('vocap-hangman-skin');
  return (HANGMAN_SKINS.find(s=>s.id===id)||HANGMAN_SKINS[0]).id;
}
function setHangmanSkin(id){
  localStorage.setItem('vocap-hangman-skin', id);
  if(HM){ HM.skin=id; HM.showSkins=false; }
  renderHangman();
}

let HM = null;   // {w, units, guessed:Set, wrong, done:null|'won'|'lost', skin, showSkins, gain, cardHtml}
let HM_ALPHABET_CACHE = null;
/* English guesses the fixed a-z alphabet; Thai has no fixed 26-key set,
   so the keyboard is built from every non-space, non-tone-mark character
   that actually occurs across the curated word list - every key on it is
   guaranteed to be a real answer somewhere, never a dead key. */
function hangmanAlphabet(){
  if(HM_ALPHABET_CACHE) return HM_ALPHABET_CACHE;
  if(GAME!=='th'){ HM_ALPHABET_CACHE = 'abcdefghijklmnopqrstuvwxyz'.split(''); return HM_ALPHABET_CACHE; }
  const set = new Set();
  for(const w of BANK) for(const ch of w.spell) if(ch!==' ') set.add(ch);
  HM_ALPHABET_CACHE = [...set].sort((a,b)=>a.localeCompare(b,'th'));
  return HM_ALPHABET_CACHE;
}
function pickHangmanWord(){
  const unseen = BANK.filter(w=>!seen.has(w.id));
  const pool = unseen.length ? unseen : BANK;
  return pool[Math.floor(Math.random()*pool.length)];
}
function openHangman(){
  closePanel();
  $('hangman').className='show';
  hangmanNext();
}
function closeHangman(){ $('hangman').className=''; HM=null; renderTray(); renderClue(); }
/* One unit per character - tone marks included - guessed and typed in
   exactly like Anagram/Puzzle/Classic now do. Display still groups a
   revealed tone mark with whatever glyph is standing in its preceding
   slot (see hangmanBoxes/renderHangman), since a combining mark with
   nothing adjacent to sit above still won't render legibly on its own. */
function hangmanNext(){
  const w = pickHangmanWord();
  const units = clusterSpell(w.spell).map(ch=>({ch, guessable: ch!==' ', revealed:false}));
  HM = {w, units, guessed:new Set(), wrong:0, done:null, skin:loadHangmanSkin(), showSkins:false, gain:0, cardHtml:''};
  renderHangman();
}
function hangmanToggleSkins(){ if(!HM) return; HM.showSkins=!HM.showSkins; renderHangman(); }
function hangmanGuess(ch){
  if(!HM || HM.done || HM.guessed.has(ch)) return;
  HM.guessed.add(ch);
  const hit = HM.units.some(u=>u.guessable && u.ch===ch);
  if(hit){
    for(const u of HM.units) if(u.guessable && u.ch===ch) u.revealed=true;
  } else {
    HM.wrong++;
  }
  checkHangmanEnd();
  renderHangman();
}
/* Groups each letter with any combining marks immediately following it
   into one visual box - purely structural, based on the word's own
   composition, independent of what's been guessed yet. */
function hangmanBoxes(units){
  const boxes=[];
  for(const u of units){
    if(COMBINING.has(u.ch) && boxes.length) boxes[boxes.length-1].marks.push(u);
    else boxes.push({base:u, marks:[]});
  }
  return boxes;
}
function checkHangmanEnd(){
  if(!HM || HM.done) return;
  if(HM.units.every(u=>!u.guessable || u.revealed)){ HM.done='won'; hangmanAward(); }
  else if(HM.wrong>=HANGMAN_MAX_WRONG){ HM.done='lost'; HM.units.forEach(u=>u.revealed=true); }
}
function hangmanAward(){
  const w = HM.w;
  const gain = seen.has(w.id) ? 0 : sparksFor(w.letters);
  HM.gain = gain;
  if(seen.has(w.id)){ sparks++; save(); speakEntry(w); }
  else { sparks+=gain; seen.add(w.id); save(); speakEntry(w); logWord(w); checkGrowth(); }
  HM.cardHtml = `<div class="wordcard show">${puzzleCardHTML(w,gain)}</div>`;
}
function renderHangman(){
  if(!HM) return;
  const skin = HANGMAN_SKINS.find(s=>s.id===HM.skin) || HANGMAN_SKINS[0];

  if(HM.showSkins){
    const cards = HANGMAN_SKINS.map(s=>`
      <div class="modecard${s.id===HM.skin?' here':''}" onclick="setHangmanSkin('${s.id}')">
        <span class="ic">${s.icon}</span><b>${t(s.nameKey)}</b>
      </div>`).join('');
    $('hangman').innerHTML = `<div class="sheet">
      <h2>${t('chooseSkin')}</h2>
      <div class="modegrid">${cards}</div>
      <div class="row"><button onclick="hangmanToggleSkins()">${t('backToGame')}</button></div>
    </div>`;
    return;
  }

  /* English keeps the classic boxed-letter look - one bordered slot per
     letter, filled in as guessed. Thai can't use that layout: a tone mark
     or vowel mark only stacks correctly onto a *real* Thai base character
     sharing its span, and there's no guarantee the base has been guessed
     yet when the mark is (they're guessed independently). Boxing them
     separately splits a mark from its base into two spans, which breaks
     the stacking outright; a dotted-circle placeholder for a lone mark
     is unreliable too, since it isn't a real Thai base for the font to
     attach to. So Thai renders as one flowing text span instead - the
     same trick .thword already relies on - and a guessed mark simply
     waits to appear until its own base has also been found, so nothing
     is ever shown without a real letter under it. */
  const blanks = GAME==='th'
    ? `<span class="hmwordTh">${esc(hangmanBoxes(HM.units).map(box=>{
        if(!box.base.guessable) return '';
        if(!box.base.revealed) return '_';
        return box.base.ch + box.marks.filter(m=>m.revealed).map(m=>m.ch).join('');
      }).join(' '))}</span>`
    : hangmanBoxes(HM.units).map(box=>{
        if(!box.base.guessable) return `<span class="hmgap"></span>`;
        const baseTxt = box.base.revealed ? box.base.ch : '';
        if(!baseTxt) return `<span class="hmslot"></span>`;
        return `<span class="hmslot filled">${baseTxt}</span>`;
      }).join('');

  const keys = hangmanAlphabet().map(ch=>{
    const done = HM.guessed.has(ch);
    const hit = done && HM.units.some(u=>u.guessable && u.ch===ch);
    const cls = done ? (hit?'good':'bad') : '';
    const label = ch.toUpperCase ? ch.toUpperCase() : ch;
    return `<button class="hmkey ${cls}" ${done?'disabled':''} onclick="hangmanGuess('${ch.replace(/'/g,"\\'")}')">${label}</button>`;
  }).join('');

  const won = HM.done==='won', lost = HM.done==='lost';
  const msg = won ? `+${HM.gain} ✨ ${t('youWon')}` : lost ? `${t('youLost')} "${HM.w.word}"` : '';

  $('hangman').innerHTML = `<div class="sheet">
    <h2>${t('hangmanTitle')}</h2>
    <div class="sub">${t('hangmanSub')}</div>
    <div class="hmstage">${skin.draw(HM.wrong, HANGMAN_MAX_WRONG)}</div>
    <div class="hmguesses">${t('guessesLeft')}: ${HANGMAN_MAX_WRONG-HM.wrong}</div>
    <div class="hmword">${blanks}</div>
    <div class="clueline">🔎 ${HM.w.definition}</div>
    <div class="hmkeys">${keys}</div>
    <div class="msg ${won?'good':lost?'bad':''}">${msg}</div>
    <div id="hmCard">${HM.cardHtml}</div>
    <div class="row">
      ${(won||lost) ? `<button class="primary" onclick="hangmanNext()">${t('newWord')}</button>` : ''}
      <button onclick="hangmanToggleSkins()">${skin.icon} ${t('chooseSkin')}</button>
    </div>
    <div class="quitrow"><button onclick="closeHangman()">${t('backToGame')}</button></div>
  </div>`;
}

$('speed').onclick=()=>{ fillTrayNow(); };

/* Skip to the next run: for when the tray is full, the clue won't crack, and
   waiting out Last Call is just dead time. Leftover letters still pay out. */
$('skip').onclick=()=>{
  if(!confirm('Start a fresh run? Leftover letters become sparks and new clues are drawn.')) return;
  sparks+=pool.length;
  snoozeUnsolved(); save();
  startCycle();
  flash('new run started','');
};
function redrawOpenCards(){
  if(shownCard){
    if(shownCard.w) showCard(shownCard.w, shownCard.gain);
    else showDictCard(shownCard.word);
  }
  if(shownPop){
    if(shownPop.w){ const w=shownPop.w; openPop(cardHTML(w,0));
      const s=document.querySelector('#popcard #c-speak');
      if(s) s.onclick=()=>{speechSynthesis.cancel();speak(englishOf(w),{rate:0.8})}; }
    else openPop(dictCardHTML(shownPop.word),'dict');
  }
}
$('lang').onclick=()=>{
  /* Adds or removes the learning-language layer: Thai clues alongside the
     English ones, and Thai on the discovery card. */
  lang = lang==='th' ? 'en' : 'th';
  localStorage.setItem('vocap-learn', lang);
  applyUI();
  renderClue();
  redrawOpenCards();
};
/* The promotion list: dictionary words this player forms most often are the
   best candidates to become curated entries (hand-written definition, fun
   fact, Thai). This is how the 966 grows - driven by real play. */
$('promote').onclick=()=>{
  const rows=Object.entries(inkTally).sort((a,b)=>b[1]-a[1]).slice(0,25);
  if(!rows.length){flash('no dictionary words formed yet','');return}
  const list=rows.map(([w,n])=>`${w} (${n})`).join(', ');
  $('c-word').textContent='Promotion candidates';
  $('c-thword').textContent='';
  $('c-def').textContent='Dictionary words you form most often. These are the best candidates to hand-write into the curated collection.';
  $('c-thdef').textContent=''; $('c-hist').textContent=list;
  $('c-thhist').textContent=''; $('c-sent').textContent='';
  $('c-meta').textContent=`${Object.keys(inkTally).length} distinct dictionary words formed · copy this list into Notion`;
  $('card').className='show';
};
$('reset').onclick=()=>{if(confirm('Wipe save?')){localStorage.removeItem('vocap');location.reload()}};

/* ---- Starter Pack: the ten 2-letter words can't be spelled (3-letter
   minimum), so they arrive as a daily gift. Doubles as the tutorial and
   completes a sub-list on day 10, which triggers the first tray upgrade. ---- */
function starterGift(){
  const today=new Date().toISOString().slice(0,10);
  if(lastGift===today) return;                       // one per day
  const gifts=BANK_ALL.filter(w=>w.starter&&!seen.has(w.id));
  if(!gifts.length) return;
  const w=gifts[0];
  seen.add(w.id); lastGift=today; starterDay++; sparks+=10; save();
  setTimeout(()=>{ speakWord(w.word); showCard(w,10);
    flash(`🎁 Starter Pack gift ${starterDay}/10 — "${w.word}"`,'good'); }, 600);
}

/* ---------------- boot ---------------- */
let BANK_ALL=[];
async function loadJSON(...paths){
  let last;
  for(const path of paths){
    try{
      const r = await fetch(path);
      if(r.ok) return await r.json();
      last = new Error(r.status+' '+path);
    }catch(e){ last=e; }
  }
  throw last;
}

/* One load path. The page has already decided which game this is, so there is
   no branch here and nothing to choose at startup. */
Promise.all([
  loadJSON(CFG.data, '../content/' + CFG.data),
  CFG.dict ? loadJSON(CFG.dict, '../content/' + CFG.dict).catch(()=>null)
           : Promise.resolve(null)
]).catch(err=>{
  $('msg').textContent = 'Could not load ' + CFG.data + ' — it must sit beside this page';
  $('msg').className = 'bad';
  throw err;
}).then(async ([d, dict])=>{
  try{
    BANK_ALL = d.words;
    BANK = d.words.filter(w=>!w.starter);
    /* Replace the built-in table with one derived from this game's own words,
       so noise letters are always letters this game actually uses. */
    const df = deriveFreq(BANK_ALL);
    for(const k in FREQ) delete FREQ[k];
    Object.assign(FREQ, df);
    if(dict){
      for(const k in dict.shelves) for(const w of dict.shelves[k]) DICT.add(w);
      DEFS = dict.defs || {};
    }
    $('total').textContent = BANK.length;
    load(); startCycle();
    if(GAME==='en') starterGift();
    applyUI();
    await authInit();
    /* CuppaThai's copy sets requireAuth in VOCAP_CONFIG; the open GitHub
       Pages copy never does, so this is a no-op there. */
    if(CFG.requireAuth && !AUTH_USER){ renderAuthGate('signin'); return; }
    enterGame();
  }catch(err){
    /* A fault from here is a bug in the game, not a missing file, and must not
       be reported as one. */
    $('msg').textContent = 'Something went wrong starting the game: ' + err.message;
    $('msg').className = 'bad';
    console.error(err);
  }
}).catch(()=>{});

/* The language choice is the front door now, every time - not just a
   corner button you might not notice. A deep link (?open=race etc.) is
   an explicit choice already made, so it skips straight past both the
   language screen and the modes menu. ?open=modes is the one link that
   skips only the language screen: it is how chooseLanguage() lands on
   the other page already past the question it just answered. */
function enterGame(){
  const openParam = new URLSearchParams(location.search).get('open');
  if(openParam==='race') openRace();
  else if(openParam==='anagram' || openParam==='listening' || openParam==='puzzle') openPuzzle(openParam);
  else if(openParam==='hangman') openHangman();
  else if(openParam==='modes') showModeMenu();
  else showLanguageSplash();
}
