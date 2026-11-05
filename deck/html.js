// Render the same slide commands as PowerPoint, with native inline SVG charts.
const fs = require('node:fs/promises');
const path = require('node:path');
const {THEME, buildContent} = require('./content.js');
const esc = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors = {...THEME.colors, text1:THEME.colors.dk1, text2:THEME.colors.dk2, background1:THEME.colors.lt1, background2:THEME.colors.lt2};
const color = value => '#'+(colors[value]??value??THEME.colors.dk1);
const box = o => `left:${o.x*96}px;top:${o.y*96}px;width:${o.w*96}px;height:${(o.h??.5)*96}px;`;
const font = o => `font-size:${(o.fontSize??16)*4/3}px;color:${color(o.color)};font-weight:${o.bold?700:400};text-align:${o.align??'left'};`;

function recordContent() {
  const slides=[], masters=new Map();
  const pres={slides, SchemeColor:Object.fromEntries(Object.keys(colors).map(k=>[k,k])),
    ShapeType:{roundRect:'roundRect',ellipse:'ellipse',line:'line',rightArrow:'rightArrow'},ChartType:{bar:'bar',line:'line'},
    addSection(){}, defineSlideMaster(o){masters.set(o.title,structuredClone(o));},
    addSlide(o){
      const master=masters.get(o.masterName), objects=[];
      const slide={master,objects,notes:'',
        addText(text,options){
          const placeholder=master.objects.find(x=>x.placeholder?.options.name===options.placeholder)?.placeholder;
          objects.push({type:'text',text,options:{...placeholder?.options,...options}});
        },
        addShape(shape,options){objects.push({type:'shape',shape,options});},
        addChart(chart,data,options){objects.push({type:'chart',chart,data,options});},
        addImage(options){objects.push({type:'image',options});},
        addTable(data,options){objects.push({type:'table',data,options});},
        addNotes(notes){slide.notes=notes;}
      };
      for(const object of master.objects) {
        if(object.rect)slide.addShape('rect',object.rect);
        if(object.text)slide.addText(object.text.text,object.text.options);
      }
      if(master.slideNumber)slide.addText(String(slides.length+1),master.slideNumber);
      slides.push(slide);return slide;
    }};
  buildContent(pres);return slides;
}

function renderText(text,o) {
  const runs=Array.isArray(text)?text:[{text}], paragraphs=[];let current='';
  for(const run of runs) {
    const r=run.options??{};
    current+=`<span style="${r.fontSize?`font-size:${r.fontSize*4/3}px;`:''}${r.bold?'font-weight:700;':''}${r.color?`color:${color(r.color)};`:''}">${r.bullet?'• ':''}${esc(run.text).replace(/\n/g,'<br>')}</span>`;
    if(r.breakLine){paragraphs.push(current);current='';}
  }
  if(current)paragraphs.push(current);
  return `<div class="object text" style="${box(o)}${font(o)}">${paragraphs.map(p=>`<p style="margin-bottom:${(o.paraSpaceAfter??0)*4/3}px">${p}</p>`).join('')}</div>`;
}

function svgChart(type,data,o) {
  const w=o.w*96,h=o.h*96,horizontal=type==='bar'&&o.barDir==='bar';
  const labels=data[0].labels, max=o.valAxisMaxVal??Math.max(...data.flatMap(s=>s.values))*1.18;
  const left=horizontal?200:58, right=25, top=43, bottom=o.showLegend?70:45;
  const pw=w-left-right, ph=h-top-bottom, palette=o.chartColors??[THEME.colors.accent1,THEME.colors.accent3];
  const number=v=>o.dataLabelFormatCode?.includes('.')?v.toFixed(o.dataLabelFormatCode.split('.')[1].length):String(Math.round(v*100)/100);
  const label=(x,y,t,anchor='middle',size=14,fill=THEME.colors.dk1)=>`<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="#${fill}">${esc(t)}</text>`;
  let svg=label(w/2,20,o.title??'', 'middle',16);
  for(let i=0;i<=4;i++) {
    const v=max*i/4;
    if(horizontal){const x=left+pw*i/4;svg+=`<path d="M${x},${top}v${ph}" stroke="#E8EFEA"/>`+label(x,top+ph+25,number(v));}
    else {const y=top+ph-ph*i/4;svg+=`<path d="M${left},${y}h${pw}" stroke="#E8EFEA"/>`+label(left-9,y+5,max<.1?v.toFixed(3):Math.round(v),'end',12);}
  }
  labels.forEach((t,i)=>{
    if(horizontal)svg+=label(left-12,top+(i+.5)*ph/labels.length+5,t,'end',14);
    else svg+=label(left+(i+.5)*pw/labels.length,top+ph+23,t);
  });
  data.forEach((series,j)=>{
    const c=palette[j%palette.length], points=[];
    series.values.forEach((v,i)=>{
      if(type==='line') {
        const x=left+(i+.5)*pw/labels.length,y=top+ph-v/max*ph;
        points.push(`${x},${y}`);svg+=`<circle cx="${x}" cy="${y}" r="4" fill="#${c}"/>`+label(x,y-12,number(v),'middle',12,c);
      } else if(horizontal) {
        const bh=ph/labels.length*.58/data.length,y=top+(i+.21)*ph/labels.length+j*bh;
        svg+=`<rect x="${left}" y="${y}" width="${v/max*pw}" height="${bh}" rx="2" fill="#${c}"/>`+label(left+v/max*pw+8,y+bh*.7,number(v),'start');
      } else {
        const bw=pw/labels.length*.64/data.length,x=left+(i+.18)*pw/labels.length+j*bw,y=top+ph-v/max*ph;
        svg+=`<rect x="${x}" y="${y}" width="${bw-4}" height="${v/max*ph}" rx="2" fill="#${c}"/>`+label(x+(bw-4)/2,y-9,number(v));
      }
    });
    if(points.length)svg+=`<polyline points="${points.join(' ')}" fill="none" stroke="#${c}" stroke-width="2.5"/>`;
    if(o.showLegend) {
      const x=left+j*pw/data.length;
      svg+=`<rect x="${x}" y="${h-21}" width="12" height="12" fill="#${c}"/>`+label(x+19,h-10,series.name,'start',13);
    }
  });
  return `<svg class="object chart" style="${box(o)}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.altText??o.title)}"><title>${esc(o.altText??o.title)}</title>${svg}</svg>`;
}

function renderObject(object) {
  const o=object.options;
  if(object.type==='text')return renderText(object.text,o);
  if(object.type==='chart')return svgChart(object.chart,object.data,o);
  if(object.type==='image')return `<img class="object" style="${box(o)}" src="img/deck/${esc(path.basename(o.path))}" alt="${esc(o.altText??'')}">`;
  if(object.type==='table') {
    const rows=object.data.map(row=>`<tr>${row.map((cell,i)=>{
      const t=typeof cell==='object'?cell.text:cell,opts={...o,...cell?.options};
      return `<td style="${font(opts)}${opts.fill?`background:${color(opts.fill.color)};`:''}width:${o.colW[i]*96}px;height:${o.rowH*96}px">${esc(t)}</td>`;
    }).join('')}</tr>`).join('');
    return `<table class="object slide-table" style="${box({...o,h:o.rowH*object.data.length})}">${rows}</table>`;
  }
  const shape=object.shape;
  return `<div aria-hidden="true" class="object shape ${shape}" style="${box(o)}background:${shape==='line'?color(o.line?.color):color(o.fill?.color)};${shape==='line'?'height:2px;':''}"></div>`;
}

async function buildHTML() {
  const slides=recordContent();
  if(slides.length!==14)throw new Error(`Expected 14 shared slides, got ${slides.length}`);
  await fs.mkdir('site/img/deck',{recursive:true});
  for(const slide of slides)for(const object of slide.objects)if(object.type==='image')await fs.copyFile(object.options.path,`site/img/deck/${path.basename(object.options.path)}`);
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Penumbra — Presentation</title><meta name="description" content="Penumbra's 14-slide DATANOVA presentation. Solar forecasts, measured uncertainty and a public ledger."><link rel="icon" href="data:,"><link rel="stylesheet" href="deck.css"><script src="deck.js" defer></script></head><body><header class="viewer-bar"><a href="index.html">← Penumbra</a><span>DATANOVA 2026</span><a href="Penumbra_DATANOVA_2026.pptx" download>Download PowerPoint</a></header><main aria-label="Presentation">${slides.map((s,i)=>`<section class="slide${s.master.title==='DARK'?' dark':''}" id="slide-${i+1}" aria-label="Slide ${i+1} of ${slides.length}"${i?' hidden':''}><div class="canvas">${s.objects.map(renderObject).join('')}</div></section>`).join('')}</main><nav class="viewer-controls" aria-label="Slide navigation"><button id="previous" type="button" aria-label="Previous slide">← Previous</button><output id="slide-counter" aria-live="polite">1 / 14</output><button id="next" type="button" aria-label="Next slide">Next →</button><button id="print" type="button">Print / PDF</button></nav><p class="hint">Use the arrow keys or swipe. Print saves one slide per page.</p></body></html>`;
  await fs.writeFile('site/deck.html.tmp',html);await fs.rename('site/deck.html.tmp','site/deck.html');
  return slides;
}
module.exports={buildHTML,recordContent};
