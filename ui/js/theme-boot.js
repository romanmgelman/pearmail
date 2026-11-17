// Runs before the first paint: put the saved light/dark choice on the page right away,
// so the startup screen already has the app's look (the app module sets it again later).
try {
  const t = JSON.parse(localStorage.getItem("pm.theme") || '"system"');
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch {}
