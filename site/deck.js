const slides=[...document.querySelectorAll('.slide')];
const previous=document.getElementById('previous'),next=document.getElementById('next'),counter=document.getElementById('slide-counter');
let index=0;
function resize(){const scale=document.querySelector('main').clientWidth/1280;for(const slide of slides)slide.firstElementChild.style.transform=`scale(${scale})`;}
function show(n){index=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,i)=>{s.hidden=i!==index;});counter.textContent=`${index+1} / ${slides.length}`;previous.disabled=index===0;next.disabled=index===slides.length-1;history.replaceState(null,'',`#slide-${index+1}`);resize();}
function restore(){const n=/^#slide-(\d+)$/.exec(location.hash);show(n?Number(n[1])-1:0);}
previous.addEventListener('click',()=>show(index-1));next.addEventListener('click',()=>show(index+1));
document.addEventListener('keydown',e=>{if(e.altKey||e.ctrlKey||e.metaKey)return;const key=e.key;if(['ArrowRight','PageDown','ArrowLeft','PageUp','Home','End'].includes(key)){e.preventDefault();show(key==='Home'?0:key==='End'?slides.length-1:index+(['ArrowRight','PageDown'].includes(key)?1:-1));}});
document.getElementById('print').addEventListener('click',()=>window.print());
let touchX;
document.querySelector('main').addEventListener('touchstart',e=>{touchX=e.changedTouches[0].clientX;},{passive:true});
document.querySelector('main').addEventListener('touchend',e=>{const dx=e.changedTouches[0].clientX-touchX;if(Math.abs(dx)>40)show(index+(dx<0?1:-1));},{passive:true});
window.addEventListener('hashchange',restore);new ResizeObserver(resize).observe(document.querySelector('main'));restore();
