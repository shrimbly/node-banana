// A styling marker only: keep Node and native APIs out of the page's world.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktopPlatform = process.platform;
});
