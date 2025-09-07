import { encodedEN } from '../wordlist-obf.js';
const key='fd@3r!@#rxc$%g';
function xorDecode(str,key){return str.split('').map((c,i)=>String.fromCharCode(c.charCodeAt(0)^key.charCodeAt(i%key.length))).join('');}
const b=Buffer.from(encodedEN,'base64').toString('utf8');
console.log('First 40 of xored utf8 string:',JSON.stringify(b.slice(0,40)));
const json=xorDecode(b,key);
console.log('First 80 of json:',JSON.stringify(json.slice(0,80)));
console.log('Starts with [ ?',json.startsWith('['));
try { JSON.parse(json); console.log('Parse OK length', json.length);} catch(e){ console.error('Parse error', e.message);}
