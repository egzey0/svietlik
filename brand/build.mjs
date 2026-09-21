// Draws the logo from the two pixel grids next to this file.
//   node brand/build.mjs
// # body, w wing, o glow, * glow core, + halo
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const grid = (name) => readFileSync(new URL(name, here), 'utf8').trimEnd().split('\n');

const themes = {
  light: { '#': '#1a1712', w: '#8f887c', text: '#1a1712' },
  dark: { '#': '#ece6da', w: '#6f695f', text: '#ece6da' },
};
const glow = { o: '#ffb000', '*': '#ffe9a8' };

function pixels(rows, px, x0, y0, paint) {
  let out = '';
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const fill = paint(ch);
      if (fill) out += `<rect x="${x0 + x * px}" y="${y0 + y * px}" width="${px}" height="${px}" ${fill}/>`;
    }),
  );
  return out;
}

const markPaint = (theme) => (ch) => {
  if (ch === '+') return 'fill="#ffb000" opacity=".22"';
  const color = glow[ch] ?? theme[ch];
  return color && `fill="${color}"`;
};

function logo(theme) {
  const mark = grid('mark.txt');
  const word = grid('wordmark.txt');
  const px = 10;
  const wordPx = 8;
  const gap = 3 * px;
  const markW = mark[0].length * px;
  const h = mark.length * px;
  const w = markW + gap + word[0].length * wordPx;
  const wordY = Math.round((h - word.length * wordPx) / 2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">` +
    pixels(mark, px, 0, 0, markPaint(theme)) +
    pixels(word, wordPx, markW + gap, wordY, (ch) => ch === '#' && `fill="${theme.text}"`) +
    '</svg>\n'
  );
}

function icon() {
  const mark = grid('mark.txt');
  const px = 32;
  const size = 512;
  const x0 = (size - mark[0].length * px) / 2;
  const y0 = (size - mark.length * px) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#0a0805"/>` +
    pixels(mark, px, x0, y0, markPaint(themes.dark)) +
    '</svg>\n'
  );
}

writeFileSync(new URL('../docs/logo-light.svg', here), logo(themes.light));
writeFileSync(new URL('../docs/logo-dark.svg', here), logo(themes.dark));
writeFileSync(new URL('icon.svg', here), icon());
