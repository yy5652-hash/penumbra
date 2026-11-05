// Playwright 1.64.1: https://playwright.dev/docs/api/class-browser
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
export async function localBrowser() {
  const root=resolve('site'),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
  const server=createServer(async(req,res)=>{
    const file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname).replace(/\/$/,'/index.html'));
    if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}
    try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream'});res.end(bytes);}
    catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{browser=await chromium.launch({headless:true});}
  catch(e){server.close();throw e;}
  const base=`http://127.0.0.1:${server.address().port}`;
  return {browser,base,close:async()=>{await browser.close();await new Promise(r=>server.close(r));}};
}
