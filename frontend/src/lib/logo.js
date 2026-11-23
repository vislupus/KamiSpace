// The KamiSpace mark: a "K" folded from a strip of paper (kami = paper).
const NS = 'http://www.w3.org/2000/svg';

export function logoMark(size = 20) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('logo-mark');
  const shapes = [
    ['rect', { width: 32, height: 32, rx: 8, fill: 'var(--accent)' }],
    ['path', { d: 'M9 7h4.4v18H9z', fill: 'var(--accent-contrast)' }],
    ['path', { d: 'M13.4 16.2 20.3 7h5.2l-8.6 11.2z', fill: 'var(--accent-contrast)' }],
    [
      'path',
      {
        d: 'M15.2 15.4 25.6 25h-5.5l-6.7-6.6z',
        fill: 'var(--accent-contrast)',
        'fill-opacity': '.72',
      },
    ],
  ];
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}
