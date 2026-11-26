// Builds the SAMPLE draft used to test "Your paper" (Word and PDF). It is labelled as a sample:
// one reference is invented (a real DOI attached to a made-up paper), one citation is missing
// from the list, one listed reference is never cited, and one sentence misquotes a number.
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const OUT = process.argv[2] || path.join(__dirname);

const BODY = [
  'SAMPLE DRAFT for testing Paper Trail. Not a real paper; one reference is deliberately invented.',
  'Introduction',
  'Home working lifted employee performance by 31% in a large field experiment (Bloom et al., 2015).',
  'Deep learning has transformed speech and object recognition (LeCun et al., 2015).',
  'Generative AI tools raised the speed of professional writing tasks (Noy & Zhang, 2023).',
  'A recent study found that students perform worse when they use AI help (Hargrove, 2024).',
  'Earlier survey work reached a similar conclusion (Smith & Jones, 2020).',
];
const REFS = [
  'Bloom, N., Liang, J., Roberts, J., & Ying, Z. J. (2015). Does working from home work? Evidence from a Chinese experiment. The Quarterly Journal of Economics, 130(1), 165–218. https://doi.org/10.1093/qje/qju032',
  'Hargrove, L. (2024). Generative AI and the student performance paradox. American Economic Review, 114(2). https://doi.org/10.1257/aer.20160696',
  'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
  'Noy, S., & Zhang, W. (2023). Experimental evidence on the productivity effects of generative artificial intelligence. Science, 381(6654), 187–192. https://doi.org/10.1126/science.adh2586',
  'Okafor, T. (2019). Remote collaboration rituals in distributed design studios. Journal of Imagined Workplaces, 7(3), 44–61.',
];

(async () => {
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: 'Working from home and performance', heading: HeadingLevel.TITLE }),
    ...BODY.map((t, i) => (i === 1 ? new Paragraph({ text: t, heading: HeadingLevel.HEADING_1 }) : new Paragraph({ children: [new TextRun(t)] }))),
    new Paragraph({ text: 'References', heading: HeadingLevel.HEADING_1 }),
    ...REFS.map((t) => new Paragraph({ children: [new TextRun(t)], indent: { left: 720, hanging: 720 } })),
  ] }] });
  fs.writeFileSync(path.join(OUT, 'SAMPLE-draft.docx'), await Packer.toBuffer(doc));

  if (process.env.PLAYWRIGHT_PATH) {
    const { chromium } = require(process.env.PLAYWRIGHT_PATH);
    const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    const page = await b.newPage();
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    await page.setContent(`<html><body style="font: 12pt Georgia; margin: 2.5cm; line-height: 1.5">
      <h1>Working from home and performance</h1>${BODY.map((t, i) => (i === 1 ? `<h2>${t}</h2>` : `<p>${esc(t)}</p>`)).join('')}
      <h2>References</h2>${REFS.map((t) => `<p style="padding-left: 1.3cm; text-indent: -1.3cm">${esc(t)}</p>`).join('')}</body></html>`);
    await page.pdf({ path: path.join(OUT, 'SAMPLE-draft.pdf'), format: 'A4' });
    await b.close();
  }
  console.log('written to', OUT);
})();
