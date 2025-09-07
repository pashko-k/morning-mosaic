#!/usr/bin/env node
const fs=require('fs');
const { createCanvas, registerFont } = (()=>{try{return require('canvas');}catch{return {};}})();
if(!createCanvas){
  console.error('canvas module not installed. Run: npm install canvas');
  process.exit(1);
}
const sizes=[192,512];
const bg='#0f172a';
const fg='#38bdf8';
const letter='W';
const outDir=__dirname + '/../icons';
fs.mkdirSync(outDir,{recursive:true});
for(const size of sizes){
  const c=createCanvas(size,size);const ctx=c.getContext('2d');
  ctx.fillStyle=bg;ctx.fillRect(0,0,size,size);
  ctx.fillStyle=fg;ctx.font=`${Math.floor(size*0.6)}px sans-serif`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(letter,size/2,size/2+size*0.03);
  const buf=c.toBuffer('image/png');
  fs.writeFileSync(`${outDir}/icon-${size}.png`,buf);
}
// Maskable (512) add padding safe area
const size=512;const c=createCanvas(size,size);const ctx=c.getContext('2d');
ctx.fillStyle=bg;ctx.fillRect(0,0,size,size);
ctx.fillStyle=fg;ctx.font=`${Math.floor(size*0.55)}px sans-serif`;
ctx.textAlign='center';ctx.textBaseline='middle';
ctx.fillText(letter,size/2,size/2+size*0.02);
fs.writeFileSync(`${outDir}/maskable-512.png`,c.toBuffer('image/png'));
console.log('Icons generated in icons/');
