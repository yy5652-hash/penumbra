// PptxGenJS 4.0.1: https://github.com/gitbrent/PptxGenJS/tree/v4.0.1
// Run: NODE_PATH=$PWD/tools/node_modules node deck/build.js
const pptxgen = require('pptxgenjs');
const fs = require('node:fs/promises');
const JSZip = require('jszip');
const {THEME, buildContent} = require('./content.js');
const {buildHTML} = require('./html.js');
(async () => {
  const pres = new pptxgen();
  buildContent(pres);
  const out = 'site/Penumbra_DATANOVA_2026.pptx';
  const temporary = 'site/.Penumbra_DATANOVA_2026.building.pptx';
  await pres.writeFile({fileName: temporary});
  // PptxGenJS sets theme fonts but does not expose the theme colour scheme.
  const zip = await JSZip.loadAsync(await fs.readFile(temporary));
  const slots = Object.entries(THEME.colors).map(([key,value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`).join('');
  for(const name of Object.keys(zip.files).filter(n=>/^ppt\/theme\/theme\d+\.xml$/.test(n))) {
    const xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/<a:clrScheme\b[^>]*>[\s\S]*?<\/a:clrScheme>/, `<a:clrScheme name="Penumbra">${slots}</a:clrScheme>`));
  }
  await fs.writeFile(temporary, await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  await fs.rename(temporary, out);
  await buildHTML();
  console.log('Built PowerPoint and HTML from 14 shared slides.');
})().catch(e=>{console.error(e);process.exitCode=1;});
