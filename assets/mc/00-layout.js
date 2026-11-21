// Bottom-nav padding on phones. Runs before the app scripts, as it did inline.
function updateBnavPadding(){
  const nav=document.querySelector('.bnav');
  if(!nav||window.innerWidth>700) return;
  requestAnimationFrame(()=>{
    const h=nav.getBoundingClientRect().height;
    if(h>0) document.documentElement.style.setProperty('--bnav-h', h+'px');
  });
}
window.addEventListener('resize',updateBnavPadding);
document.addEventListener('DOMContentLoaded',()=>{ setTimeout(updateBnavPadding,50); });
