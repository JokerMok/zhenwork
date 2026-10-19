const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const configPath = process.argv[2];
const outputDir = path.resolve(process.argv[3] || process.cwd());
if (!configPath) {
  console.error('Usage: node generate_images.js job.json [output-directory]');
  process.exit(2);
}

const job = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const field of ['role', 'company', 'apply']) {
  if (typeof job[field] !== 'string' || !job[field].trim()) {
    throw new Error(`Missing job field: ${field}`);
  }
}

const WIDTH = 1080;
const HEIGHT = 1350;
const FONT = '"Noto Sans CJK SC", sans-serif';
const colors = { background: '#101419', surface: '#192129', text: '#F4F7F7', muted: '#B5C4C8', accent: '#50E3B1' };

function frame(ctx, label) {
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(72, 80, 76, 8);
  ctx.fillStyle = colors.muted;
  ctx.font = `28px ${FONT}`;
  ctx.fillText(label, 72, 145);
  ctx.strokeStyle = '#31454A';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(72, 1195);
  ctx.lineTo(1008, 1195);
  ctx.stroke();
  ctx.fillStyle = colors.text;
  ctx.font = `28px ${FONT}`;
  ctx.fillText(job.company, 72, 1250, 900);
}

function lines(ctx, text, maxWidth, maxLines) {
  const result = [];
  let line = '';
  for (const character of String(text)) {
    if (character === '\n' || ctx.measureText(line + character).width > maxWidth) {
      if (line) result.push(line);
      line = character === '\n' ? '' : character;
    } else {
      line += character;
    }
  }
  if (line) result.push(line);
  if (result.length > maxLines) {
    result.length = maxLines;
    result[maxLines - 1] = result[maxLines - 1].replace(/.$/, '…');
  }
  return result;
}

function drawLines(ctx, text, x, y, width, lineHeight, maxLines) {
  for (const line of lines(ctx, text, width, maxLines)) {
    ctx.fillText(line, x, y, width);
    y += lineHeight;
  }
  return y;
}

function save(name, draw) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  draw(canvas.getContext('2d'));
  fs.mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, name);
  fs.writeFileSync(target, canvas.toBuffer('image/png'));
  console.log(target);
}

save('cover.png', (ctx) => {
  frame(ctx, 'WE ARE HIRING');
  ctx.fillStyle = colors.text;
  ctx.font = `bold 88px ${FONT}`;
  const titleEnd = drawLines(ctx, job.role, 72, 405, 930, 112, 3);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(72, titleEnd + 24, 94, 8);
  ctx.fillStyle = colors.muted;
  ctx.font = `40px ${FONT}`;
  drawLines(ctx, job.tagline || '一起做有价值的事', 72, titleEnd + 116, 900, 58, 3);
  ctx.fillStyle = colors.surface;
  ctx.fillRect(72, 985, 936, 142);
  ctx.fillStyle = colors.text;
  ctx.font = `32px ${FONT}`;
  drawLines(ctx, `投递方式：${job.apply}`, 100, 1048, 870, 46, 2);
});

save('jd_details.png', (ctx) => {
  frame(ctx, 'ROLE DETAILS');
  ctx.fillStyle = colors.text;
  ctx.font = `bold 55px ${FONT}`;
  drawLines(ctx, job.role, 72, 245, 930, 74, 2);
  let y = 395;
  for (const [heading, entries] of [['岗位职责', job.responsibilities], ['任职要求', job.requirements]]) {
    ctx.fillStyle = colors.accent;
    ctx.font = `bold 39px ${FONT}`;
    ctx.fillText(heading, 72, y);
    y += 68;
    ctx.fillStyle = colors.text;
    ctx.font = `30px ${FONT}`;
    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, 4)) {
      y = drawLines(ctx, `• ${entry}`, 80, y, 900, 44, 2) + 12;
      if (y > 1010) break;
    }
    y += 40;
    if (y > 1030) break;
  }
  ctx.fillStyle = colors.accent;
  ctx.font = `31px ${FONT}`;
  drawLines(ctx, `投递：${job.apply}`, 72, 1130, 900, 42, 1);
});
