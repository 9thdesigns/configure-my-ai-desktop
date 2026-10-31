// The offline page's only behaviour, kept out of the HTML so the page can run
// under a CSP with no inline script.
function retry () { location.replace('https://configuremyai.com/welcome') }
document.getElementById('retry').addEventListener('click', retry)
addEventListener('online', retry)
setInterval(function () { if (navigator.onLine) retry() }, 10000)
