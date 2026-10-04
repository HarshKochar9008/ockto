// Writes the fictional demo documents to demo/. Every person, institution and
// test in them is invented. Run: npm run demo-docs
import { mkdirSync, writeFileSync } from 'node:fs';

/** Minimal text-only PDF (Helvetica, A4): enough for a real PDF parser to read. ASCII text only. */
export function makePdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const objs: string[] = [];
  const kids: string[] = [];
  pages.forEach((lines, i) => {
    const page = 4 + i * 2;
    kids.push(`${page} 0 R`);
    const stream = `BT /F1 11 Tf 15 TL 56 800 Td ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
    objs[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`;
    objs[page + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const demoDocs: Record<string, string[][]> = {
  'northbridge-requirements.pdf': [[
    'NORTHBRIDGE UNIVERSITY (FICTIONAL - DEMO DOCUMENT)',
    'Graduate Admissions Office',
    'MSc Data Science - Application Requirements, September 2027 intake',
    '',
    'Application deadline: all materials must be submitted by 15 January 2027.',
    '',
    'Required documents',
    '',
    '1. Official academic transcript. Applicants must submit an official transcript from every',
    'post-secondary institution attended, showing all courses and grades.',
    '',
    '2. Proof of English proficiency. Applicants must submit an Academic English Test (AET) score',
    'report with an overall score of at least 6.5 and no section below 6.0. The score report must',
    'still be valid on the application deadline.',
    '',
    '3. Two letters of recommendation. At least one letter must come from an academic referee.',
    '',
    '4. Personal statement of no more than 1,000 words explaining your motivation for the programme.',
    '',
    '5. Copy of a valid passport (photo page).',
    '',
    '6. Curriculum vitae (CV) listing education and work experience.',
  ], [
    'Scholarship (optional)',
    '',
    '7. Applicants who wish to be considered for the Northbridge Excellence Scholarship may submit',
    'a financial statement showing household income. This document is optional.',
    '',
    'General information',
    '',
    'The Graduate Admissions Office reviews complete applications only. Application fees are waived',
    'for the 2027 intake. Decisions are released in March 2027.',
    '',
    'This is a fictional document created for the PaperTrail demo. Northbridge University does not exist.',
  ]],
  'transcript-alex-rivera.pdf': [[
    'LAKESHORE INSTITUTE OF TECHNOLOGY (FICTIONAL - DEMO DOCUMENT)',
    'Office of the Registrar - Official Academic Transcript',
    '',
    'Student name: Alex Rivera',
    'Programme: Bachelor of Science in Computer Science',
    'Date of issue: 30 June 2026',
    '',
    'Fall 2022    CS101 Introduction to Programming        4 credits   A',
    'Fall 2022    MA110 Calculus I                         4 credits   A-',
    'Spring 2023  CS150 Data Structures                    4 credits   A',
    'Spring 2023  ST120 Introduction to Statistics         3 credits   B+',
    'Fall 2023    CS240 Databases                          4 credits   A',
    'Spring 2024  CS310 Machine Learning                   4 credits   A-',
    'Fall 2024    CS330 Distributed Systems                4 credits   B+',
    'Spring 2025  CS420 Data Visualisation                 3 credits   A',
    'Fall 2025    CS490 Capstone Project                   6 credits   A',
    '',
    'Cumulative GPA: 3.72 / 4.00',
    'Degree awarded: Bachelor of Science in Computer Science, conferred 15 June 2026.',
    '',
    'This official transcript lists all courses and grades for the student named above.',
    'Signed: M. Okafor, Registrar',
    '',
    'Fictional document created for the PaperTrail demo.',
  ]],
  'aet-score-report.pdf': [[
    'ACADEMIC ENGLISH TEST (AET) - SCORE REPORT (FICTIONAL - DEMO DOCUMENT)',
    '',
    'Candidate: Alex Rivera',
    'Test date: 12 December 2024',
    'Test centre: Lakeshore City',
    '',
    'Section scores',
    'Listening 7.5    Reading 7.0    Writing 6.5    Speaking 6.5',
    'Overall score: 7.0',
    '',
    'AET results are valid for two years from the test date.',
    'This score report is valid until 12 December 2026.',
    '',
    'Fictional document created for the PaperTrail demo. The AET does not exist.',
  ]],
};

if (import.meta.main) {
  const dir = new URL('../demo/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const [name, pages] of Object.entries(demoDocs)) {
    writeFileSync(new URL(name, dir), makePdf(pages));
    console.log(`demo/${name}`);
  }
}
