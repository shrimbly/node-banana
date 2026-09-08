function visibleBounds(saved, displays, primary) {
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]));
  const bounds = valid ? saved : { ...primary.workArea, width: 1440, height: 960 };
  const display = displays.find(display => {
    const area = display.workArea;
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  }) || primary;
  const area = display.workArea;
  const width = Math.min(area.width, Math.max(900, bounds.width));
  const height = Math.min(area.height, Math.max(600, bounds.height));
  return { x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width), y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height), width, height };
}
module.exports = { visibleBounds };
