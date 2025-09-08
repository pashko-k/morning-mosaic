// app.js
import { encodedEN, encodedUK, encodedAllowedEN, encodedAllowedUK } from './wordlist-obf.js';

// Build/version tag
const APP_VERSION = 'v0.5.4-2025-09-08-02';
console.log('[GuessMosaic] Version', APP_VERSION);

// ---------------- Decode lists ----------------
function xorDecode(str, key) {
  return str.split('').map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('');
}
const key = 'fd@3r!@#rxc$%g';
function decodeList(encoded) {
  try {
    const bin = atob(encoded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const xoredStr = new TextDecoder().decode(bytes); // XOR'ed JSON string
    const jsonStr = xorDecode(xoredStr, key);
    return JSON.parse(jsonStr).map(w => w.normalize('NFC').toUpperCase());
  } catch (e) {
    console.error('Failed to decode word list', e);
    return [];
  }
}
const WORDS_EN = decodeList(encodedEN);
const WORDS_UK = decodeList(encodedUK);
const ALLOWED_EN = new Set(decodeList(encodedAllowedEN || ''));
const ALLOWED_UK = new Set(decodeList(encodedAllowedUK || ''));

// --- Game state ---
let currentLang = 'en';
let targetWord = '';
let attempts = [];          // completed guesses only
let currentGuess = '';      // in-progress guess
let maxAttempts = 6;
let gameOver = false;
const STORAGE_KEY = 'guessmosaic-state-v1';
let firstLoad = true;


// --- DOM elements ---
const board = document.getElementById('board');
const keyboard = document.getElementById('keyboard');
const shareBtn = document.getElementById('shareBtn');
const toastEl = document.getElementById('toast');

// --- Helpers ---
function listFor(lang) {
  return lang === 'uk' ? WORDS_UK : WORDS_EN;
}
function allowedSetFor(lang) {
  return lang === 'uk' ? ALLOWED_UK : ALLOWED_EN;
}

// Deterministic daily selection (UTC date) so everyone gets same word per language per day.
function dailyIndex(words, lang) {
  // Base epoch for stability
  const epoch = Date.UTC(2025, 0, 1) / 86400000; // days since 1970 for Jan 1 2025
  const today = Date.now() / 86400000; // days since 1970
  const dayNumber = Math.floor(today - epoch);
  // Simple LCG mix with lang hash
  let h = 0; for (let i = 0; i < lang.length; i++) h = (h * 31 + lang.charCodeAt(i)) >>> 0;
  const mix = (dayNumber * 1103515245 + 12345 + h) >>> 0;
  return mix % words.length;
}

let manualOverride = null; // optional future override
function dayId() { return Math.floor(Date.now() / 86400000); }
function pickWord() {
  const words = listFor(currentLang);
  if (!words.length) return '';
  if (manualOverride && words.includes(manualOverride)) return manualOverride;
  const idx = dailyIndex(words, currentLang);
  return words[idx];
}
function showMessage(text, duration = 2000) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), duration);
}

// Evaluate a guess against target using duplicate handling
// Returns array of status strings: 'correct' | 'present' | 'absent'
function evaluateGuess(guess, target) {
  const len = target.length;
  const result = Array(len).fill('absent');
  const counts = {};
  for (let i = 0; i < len; i++) {
    const ch = target[i];
    counts[ch] = (counts[ch] || 0) + 1;
  }
  // First pass: correct positions
  for (let i = 0; i < len; i++) {
    if (guess[i] === target[i]) {
      result[i] = 'correct';
      counts[guess[i]] -= 1;
    }
  }
  // Second pass: presents
  for (let i = 0; i < len; i++) {
    if (result[i] === 'correct') continue;
    const g = guess[i];
    if (counts[g] > 0) {
      result[i] = 'present';
      counts[g] -= 1;
    }
  }
  return result;
}

function renderBoard() {
  board.innerHTML = '';
  board.style.setProperty('--cols', targetWord.length);
  for (let i = 0; i < maxAttempts; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    const guess = i < attempts.length ? attempts[i] : (i === attempts.length ? currentGuess : '');
    const finalized = i < attempts.length;
    const evalStatuses = finalized ? evaluateGuess(guess, targetWord) : [];
    for (let j = 0; j < targetWord.length; j++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const letter = guess[j] || '';
      tile.textContent = letter;
      if (finalized) {
        tile.classList.add('revealed');
        const st = evalStatuses[j];
        if (st === 'correct') tile.classList.add('correct');
        else if (st === 'present') tile.classList.add('present');
        else tile.classList.add('absent');
      } else if (letter) {
        tile.classList.add('filled');
      }
      row.appendChild(tile);
    }
    board.appendChild(row);
  }
}

function computeStatuses() {
  const status = {};
  attempts.forEach(g => {
    const evalSt = evaluateGuess(g, targetWord);
    for (let i = 0; i < g.length; i++) {
      const l = g[i];
      const st = evalSt[i];
      if (st === 'correct') status[l] = 'correct';
      else if (st === 'present') {
        if (status[l] !== 'correct') status[l] = 'present';
      } else {
        if (!status[l]) status[l] = 'absent';
      }
    }
  });
  return status;
}

function renderKeyboard() {
  keyboard.innerHTML = '';
  const status = computeStatuses();
  const rows = currentLang === 'uk'
    // Standard Ukrainian layout (ЙЦУКЕН): three rows
    ? ['ЙЦУКЕНГШЩЗХЇ', 'ФІВАПРОЛДЖЄ', 'ЯЧСМИТЬБЮҐ']
    : ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  rows.forEach((rowStr, idx) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'krow';
    if (idx === rows.length - 1) {
      const enter = document.createElement('button');
      enter.textContent = 'Enter';
      enter.className = 'key wide';
      enter.addEventListener('click', submitGuess);
      rowEl.appendChild(enter);
    }
    rowStr.split('').forEach(letter => {
      const btn = document.createElement('button');
      btn.textContent = letter;
      let cls = 'key';
      if (status[letter] === 'correct') cls += ' hint-correct';
      else if (status[letter] === 'present') cls += ' hint-present';
      else if (status[letter] === 'absent') cls += ' hint-absent';
      btn.className = cls;
      btn.addEventListener('click', () => handleKey(letter));
      rowEl.appendChild(btn);
    });
    if (idx === rows.length - 1) {
      const langBtn = document.createElement('button');
      langBtn.textContent = currentLang === 'en' ? 'UK' : 'EN';
      langBtn.className = 'key';
      langBtn.addEventListener('click', switchLanguageWithConfirm);
      rowEl.appendChild(langBtn);
      const del = document.createElement('button');
      del.textContent = 'Del';
      del.className = 'key wide';
      del.addEventListener('click', deleteLetter);
      rowEl.appendChild(del);
    }
    keyboard.appendChild(rowEl);
  });
}

function handleKey(letter) {
  if (gameOver) return;
  if (attempts.length >= maxAttempts) return;
  if (currentGuess.length >= targetWord.length) return;
  currentGuess += letter;
  saveState();
  renderBoard();
  renderKeyboard();
}

function deleteLetter() {
  if (gameOver) return;
  if (!currentGuess) return;
  currentGuess = currentGuess.slice(0, -1);
  saveState();
  renderBoard();
  renderKeyboard();
}

function submitGuess() {
  if (gameOver) return;
  if (currentGuess.length !== targetWord.length) { showMessage('Not enough letters'); return; }
  const guess = currentGuess;
  // Dictionary validation: guess must be in allowed list (or exactly the target solution)
  const allowed = allowedSetFor(currentLang);
  if (allowed.size && !allowed.has(guess) && guess !== targetWord) {
    showMessage('Not in word list');
    return;
  }
  attempts.push(guess);
  currentGuess = '';
  if (guess === targetWord) {
    showMessage('You win!');
    gameOver = true;
  } else if (attempts.length === maxAttempts) {
    showMessage(`Game over! Word was ${targetWord}`);
    gameOver = true;
  }
  saveState();
  renderBoard();
  renderKeyboard();
}

function switchLanguageWithConfirm() {
  const hasProgress = attempts.length > 0 || currentGuess.length > 0;
  if (hasProgress && !gameOver) {
    if (!window.confirm('Switch language and lose current progress?')) return;
  }
  currentLang = currentLang === 'en' ? 'uk' : 'en';
  startGame(true);
  showMessage(currentLang === 'en' ? 'Language: English' : 'Мова: Українська');
}

function saveState() {
  try {
    const payload = { dayId: dayId(), lang: currentLang, solution: targetWord, attempts, currentGuess, gameOver };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_) { }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function startGame(manualSwitch = false) {
  const today = dayId();
  const restored = loadState();
  if (!manualSwitch && firstLoad && restored && restored.dayId === today && restored.lang) {
    currentLang = restored.lang;
  }

  const solution = pickWord();
  if (!solution) { showMessage('No words loaded'); return; }

  if (restored && restored.dayId === today && restored.lang === currentLang && restored.solution === solution) {
    // Restore prior progress
    targetWord = restored.solution;
    attempts = Array.isArray(restored.attempts) ? restored.attempts.slice(0, maxAttempts) : [];
    currentGuess = restored.currentGuess || '';
    if (currentGuess.length > solution.length) currentGuess = currentGuess.slice(0, solution.length);
    gameOver = !!restored.gameOver;
  } else {
    // Fresh daily game
    targetWord = solution;
    attempts = [];
    currentGuess = '';
    gameOver = false;
  }
  saveState();
  renderBoard();
  renderKeyboard();
  firstLoad = false;
}

// --- Share feature ---
function buildShareText() {
  // Build emoji grid from finalized (full-length) guesses
  const lines = attempts.filter(g => g.length === targetWord.length);
  const emojiLines = lines.map(g => {
    const evalSt = evaluateGuess(g, targetWord);
    return evalSt.map(st => st === 'correct' ? '🟩' : st === 'present' ? '🟨' : '⬛').join('');
  });
  const solved = gameOver && lines[lines.length - 1] === targetWord;
  const attemptsCount = solved ? lines.length : 'X';
  return `Guess Mosaic (${currentLang.toUpperCase()}) ${attemptsCount}/${maxAttempts}\n` + emojiLines.join('\n');
}

async function shareResult() {
  if (!attempts.length) { showMessage('Nothing to share yet'); return; }
  const text = buildShareText();
  try {
    if (navigator.share) {
      await navigator.share({ text });
      showMessage('Shared');
    } else {
      await navigator.clipboard.writeText(text);
      showMessage('Result copied');
    }
  } catch (e) {
    console.error(e);
    try {
      await navigator.clipboard.writeText(text);
      showMessage('Result copied');
    } catch {
      showMessage('Share failed');
    }
  }
}

if (shareBtn) {
  shareBtn.addEventListener('click', shareResult);
}

startGame(false);

// --- Physical keyboard support ---
window.addEventListener('keydown', (e) => {
  if (gameOver && e.key !== 'Enter') return;
  if (e.key === 'Enter') { submitGuess(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { deleteLetter(); return; }
  const letters = currentLang === 'uk'
    ? 'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ'
    : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const k = e.key.toUpperCase();
  if (letters.includes(k)) handleKey(k);
});
