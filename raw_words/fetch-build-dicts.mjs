#!/usr/bin/env node
/**
 * fetch-build-dicts.mjs
 * Builds large allowed guess lists from public sources defined in sources.json.
 * - Fetch remote sources
 * - Extract words (handles JSON arrays or plain text)
 * - Normalize (uppercase, NFC)
 * - Filter by length(s) and alphabet per language
 * - Remove non-letter characters
 * - De-duplicate and ensure all solution words are included
 * - Write allowed-en.txt / allowed-uk.txt
 * - Then run obfuscator to regenerate encoded bundles
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const SRC_CFG = path.join(__dirname, 'sources.json');
const SOL_EN = path.join(__dirname, 'words-en.txt');
const SOL_UK = path.join(__dirname, 'words-uk.txt');
const OUT_EN = path.join(__dirname, 'allowed-en.txt');
const OUT_UK = path.join(__dirname, 'allowed-uk.txt');

const CACHE_DIR = path.join(__dirname,'.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, {recursive:true});

const INSECURE = process.env.INSECURE_FETCH === '1';

function fetchRemote(url, attempt=1){
  return new Promise((resolve, reject)=>{
    const lib = url.startsWith('http://') ? http : https;
    const options = new URL(url);
    if (INSECURE && lib === https) {
      options.rejectUnauthorized = false; // allow self-signed for dev
    }
    const req = lib.get(options, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchRemote(res.headers.location, attempt));
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP '+res.statusCode+' for '+url));
        return;
      }
      let data='';
      res.setEncoding('utf8');
      res.on('data', c=>data+=c);
      res.on('end', ()=>resolve(data));
    });
    req.on('error', err => {
      if (attempt < 3) {
        setTimeout(()=>{
          fetchRemote(url, attempt+1).then(resolve, reject);
        }, attempt*300);
      } else reject(err);
    });
  });
}

async function fetchText(url){
  if (url.startsWith('file:')) {
    const p = url.replace('file:','');
    return fs.readFileSync(p,'utf8');
  }
  if (/^\.{0,2}\//.test(url)) { // relative path
    const p = path.resolve(root, url);
    return fs.readFileSync(p,'utf8');
  }
  const hash = Buffer.from(url).toString('base64').replace(/[^A-Za-z0-9]/g,'');
  const cacheFile = path.join(CACHE_DIR, hash+'.txt');
  if (fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile,'utf8');
  }
  // Stream to temp file first to avoid huge memory spikes
  const txt = await fetchRemote(url);
  // (Simpler approach: still full string; stack overflow likely came from JSON.parse on huge file, we no longer parse large plain text as JSON.)
  fs.writeFileSync(cacheFile, txt);
  return txt;
}

function streamFilterPlain(url, lang, lengths){
  return new Promise((resolve, reject)=>{
    const lib = url.startsWith('http://') ? http : https;
    const options = new URL(url);
    if (INSECURE && lib === https) options.rejectUnauthorized = false;
    const acc = new Set();
    // For Ukrainian we will drop tokens that are ALL CAPS in original source (likely abbreviations/names)
    // We detect by presence of at least one lowercase letter in the original token prior to uppercasing.
    let leftover='';
    const req = lib.get(options, res => {
      if (res.statusCode && res.statusCode >=300 && res.statusCode <400 && res.headers.location) {
        res.destroy();
        return resolve(streamFilterPlain(res.headers.location, lang, lengths));
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP '+res.statusCode)); return; }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        let data = leftover + chunk;
        let idx;
        let start = 0;
        while ((idx = data.indexOf('\n', start)) !== -1) {
          const rawLine = data.slice(start, idx).replace(/\r$/,'');
          start = idx + 1;
          if (!rawLine) continue;
          if (/^\d+$/.test(rawLine)) continue; // numeric count
          const baseToken = rawLine.split(/[\s/]/)[0].trim();
          if (!baseToken) continue;
          const norm = baseToken.normalize('NFC');
          const up = norm.toUpperCase();
          if (!lengths.includes(up.length)) continue;
          if (lang === 'uk') {
            // Skip if original had no lowercase letters => likely abbreviation/proper name
            if (norm === up) continue;
            if (!/^[А-ЯЇІЄҐа-яїієґ]+$/.test(norm)) continue; // restrict alphabet
          } else if (lang === 'en') {
            if (!/^[A-Za-z]+$/.test(norm)) continue;
          }
          // final pattern check on uppercase normalized
          if (lang === 'en') {
            if (!/^[A-Z]+$/.test(up)) continue;
          } else if (lang === 'uk') {
            if (!/^[А-ЯЇІЄҐ]+$/.test(up)) continue;
          }
          acc.add(norm); // keep original case for downstream normalization logic
        }
        leftover = data.slice(start);
      });
      res.on('end', () => {
        if (leftover) {
          const tokRaw = leftover.trim();
          if (tokRaw) {
            const norm = tokRaw.split(/[\s/]/)[0].trim().normalize('NFC');
            const up = norm.toUpperCase();
            if (lengths.includes(up.length)) {
              if (lang === 'uk') {
                if (norm !== up && /^[А-ЯЇІЄҐа-яїієґ]+$/.test(norm) && /^[А-ЯЇІЄҐ]+$/.test(up)) acc.add(norm);
              } else if (lang === 'en') {
                if (/^[A-Za-z]+$/.test(norm) && /^[A-Z]+$/.test(up)) acc.add(norm);
              }
            }
          }
        }
    resolve(acc);
      });
    });
    req.on('error', reject);
  });
}

function extractWords(raw){
  // For huge plain lists avoid holding entire array if we can early filter later
  const trimmed = raw.trimStart();
  if (!trimmed) return [];
  if (raw.length < 5_000_000 && ((trimmed.startsWith('[') && raw.trimEnd().endsWith(']')) || trimmed.startsWith('{'))) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (Array.isArray(parsed.words)) return parsed.words.map(String);
    } catch(_) { /* fallback */ }
  }
  // Limit to first 500k lines to avoid extreme memory usage
  const lines = raw.split(/\r?\n/);
  if (lines.length > 500000) lines.length = 500000;
  return lines.map(w=>w.trim());
}

function isLatin(word){ return /^[A-Za-z]+$/.test(word); }
function isCyrillic(word){ return /^[А-Яа-яЇїІіЄєҐґЁёЪъЫыЭэ]+$/.test(word); }

function normalizeList(words, {lang, lengths}){
  const set = new Set();
  for (const w of words) {
  if (!w) continue;
  if (/^\d+$/.test(w)) continue; // numeric line (Hunspell count)
  const base = w.split('/')[0];
  // For Ukrainian drop if the ORIGINAL token (base) has no lowercase letters (abbrev / proper name)
  if (lang === 'uk' && !/[a-zа-яїієґ]/.test(base)) continue;
  const upper = base.normalize('NFC').toUpperCase();
  if (lang === 'en' && !isLatin(upper)) continue;
  if (lang === 'uk' && !isCyrillic(upper)) continue;
  if (!lengths.includes(upper.length)) continue;
  if (lang === 'en' && /[^A-Z]/.test(upper)) continue;
  set.add(upper);
  }
  return Array.from(set).sort();
}

async function buildFor(lang, cfg){
  const allWords = [];
  for (const url of cfg.sources) {
    try {
      process.stdout.write(`[${lang}] fetching ${url} ... `);
      let words;
      // Stream very large remote .txt lists to avoid huge memory & stack usage
  if (/^https?:/.test(url) && /\.(txt|dic)$/i.test(url)) {
        words = await streamFilterPlain(url, lang, cfg.lengths);
        let size = words.size;
        if (size === 0) { // fallback: fetch whole text and regex extract
          const raw = await fetchText(url);
            const regex = lang === 'uk' ? /[А-Яа-яЇїІіЄєҐґ]{3,12}/g : /[A-Za-z]{3,12}/g;
            const m = raw.match(regex) || [];
            m.forEach(w=>words.add(w.toUpperCase()));
            size = words.size;
        }
        process.stdout.write(size+" streamed words (pre-normalized)\n");
        allWords.push(...Array.from(words));
      } else {
        const txt = await fetchText(url);
        const arr = extractWords(txt);
        process.stdout.write(arr.length+" raw words\n");
        allWords.push(...arr);
      }
    } catch(e){
      console.error(`[${lang}] Failed ${url}:`, e.message);
    }
  }
  let normalized = normalizeList(allWords, {lang, lengths: cfg.lengths});
  const dictionarySet = new Set(normalized); // capture full dictionary-derived set before pruning
  // Frequency pruning (optional)
  if (cfg.frequency && cfg.frequency.url && cfg.frequency.top) {
    try {
      process.stdout.write(`[${lang}] fetching frequency list ... `);
      const freqRaw = await fetchText(cfg.frequency.url);
      // frequency file: word<space>freq
      const linesAll = freqRaw.split(/\r?\n/);
      const lines = linesAll.slice(0, cfg.frequency.top);
      const freqList = [];
      const freqSet = new Set();
      const ukPattern = /^[А-ЯЇІЄҐ]+$/; // intentionally excludes Russian-specific letters (Ы Ъ Э Ё)
      const enPattern = /^[A-Z]+$/;
      for (const line of lines) {
        const rawTok = line.split(/\s+/)[0];
        if (!rawTok) continue;
        const up = rawTok.normalize('NFC').toUpperCase();
        if (!cfg.lengths.includes(up.length)) continue;
        if (lang === 'uk' && !ukPattern.test(up)) continue; // drop cross-language tokens
        if (lang === 'en' && !enPattern.test(up)) continue;
        // Only consider frequency words that also appear in dictionary (to avoid adding foreign or inflected outside set)
        if (!dictionarySet.has(up)) continue;
        if (!freqSet.has(up)) {
          freqSet.add(up);
          freqList.push(up);
        }
      }
      process.stdout.write(`${freqSet.size} freq words\n`);
  if (cfg.frequency.strategy === 'rank-union') {
        // Start with intersection
    let base = normalized.filter(w => freqSet.has(w)); // intersection already ensures dictionary membership
        // If too small, expand by adding ranked words until topCap or until min satisfied
        const min = cfg.frequency.min || 0;
        const cap = cfg.frequency.topCap || base.length;
        if (base.length < min) {
          for (const w of freqList) {
            if (base.length >= cap) break;
            if (!base.includes(w)) base.push(w);
          }
        }
        // Optional expansion with remaining dictionary words (ordered deterministically) to reach min threshold
        if (cfg.frequency.expandDictionary && base.length < min) {
          const remaining = Array.from(dictionarySet).filter(w => !base.includes(w));
          if (cfg.frequency.expandStrategy === 'random') {
            // Deterministic PRNG (Mulberry32) seeded by cfg.frequency.seed + lang
            const seedStr = (cfg.frequency.seed || 'seed') + ':' + lang;
            let h = 1779033703;
            for (let i=0;i<seedStr.length;i++) {
              h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
              h = h << 13 | h >>> 19;
            }
            function rnd(){
              h = Math.imul(h ^ (h >>> 16), 2246822507);
              h = Math.imul(h ^ (h >>> 13), 3266489909);
              const t = (h ^= h >>> 16) >>> 0;
              return t / 4294967296;
            }
            for (let i = remaining.length -1; i>0; i--) {
              const j = Math.floor(rnd() * (i+1));
              [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
          }
          for (const w of remaining) {
            if (base.length >= min) break;
            base.push(w);
          }
        }
        normalized = base;
      } else {
        // pure intersection strategy; no expansion
        normalized = normalized.filter(w => freqSet.has(w));
      }
    } catch(e) {
      console.warn(`[${lang}] frequency pruning skipped:`, e.message);
    }
  }
  // Ensure solution words present
  const solFile = lang === 'en' ? SOL_EN : SOL_UK;
  try {
    const sol = fs.readFileSync(solFile,'utf8').split(/\r?\n/).map(w=>w.trim()).filter(Boolean);
    for (const w of sol) normalized.push(w.toUpperCase());
  } catch(e) { console.warn(`[${lang}] Could not read solution list:`, e.message); }
  normalized = Array.from(new Set(normalized)).sort();
  const outFile = lang === 'en' ? OUT_EN : OUT_UK;
  fs.writeFileSync(outFile, normalized.join('\n')+'\n');
  console.log(`[${lang}] Wrote ${normalized.length} words to ${path.basename(outFile)}`);
}

async function main(){
  const cfg = JSON.parse(fs.readFileSync(SRC_CFG,'utf8'));
  await buildFor('en', cfg.en);
  await buildFor('uk', cfg.uk);
  // regenerate obfuscated bundle
  await import(path.join(__dirname,'obfuscateWords.cjs'));
}

main().catch(e=>{ console.error(e); process.exit(1); });
