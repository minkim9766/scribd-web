import puppeteer from 'puppeteer';
import sanitize from 'sanitize-filename';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import * as scribdRegex from '../const/ScribdRegex.js';
import * as slideshareRegex from '../const/SlideshareRegex.js';
import * as everandRegex from '../const/EverandRegex.js';
import { Image } from '../object/Image.js';

const OUTPUT_DIR = '/tmp/scribd-downloads';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    timeout: 0,
  });
}

// Helper functions injected into page context — mirrors PuppeteerSg logic
const HELPERS_SCRIPT = `
  window.__helpers__ = {
    lazyLoad: async (selector, rendertime) => {
      selector = selector || null;
      rendertime = rendertime || 100;
      await new Promise(resolve => {
        const container = selector ? document.querySelector(selector) : null;
        if (selector && !container) return resolve();
        let prevScroll = 0;
        const timer = setInterval(() => {
          if (container) {
            container.scrollTop += container.clientHeight;
            if (container.scrollTop === prevScroll) { clearInterval(timer); resolve(); return; }
            prevScroll = container.scrollTop;
            if (container.scrollTop + container.clientHeight >= container.scrollHeight) {
              clearInterval(timer); resolve();
            }
          } else {
            window.scrollBy(0, window.innerHeight * 0.8);
            if (window.innerHeight + window.scrollY >= document.body.scrollHeight) {
              clearInterval(timer); resolve();
            }
          }
        }, rendertime);
      });
    },
    hideSelectorAll: (sel) => document.querySelectorAll(sel).forEach(el => el.style.display = 'none'),
    showSelectorAll: (sel) => document.querySelectorAll(sel).forEach(el => el.style.display = 'block'),
    removeSelectorAll: (sel) => document.querySelectorAll(sel).forEach(el => el.remove()),
    removeMarginSelectorAll: (sel) => document.querySelectorAll(sel).forEach(el => el.style.margin = '0'),
  };
`;

async function injectHelpers(page) {
  await page.evaluate(HELPERS_SCRIPT);
}

function groupPagesByDimensions(pages) {
  if (!pages.length) return [];
  const groups = [];
  let ids = [pages[0].id];
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1];
    const curr = pages[i];
    if (curr.width === prev.width && curr.height === prev.height) {
      ids.push(curr.id);
    } else {
      groups.push({ ids, width: prev.width, height: prev.height });
      ids = [curr.id];
    }
  }
  groups.push({
    ids,
    width: pages[pages.length - 1].width,
    height: pages[pages.length - 1].height,
  });
  return groups;
}

async function downloadScribd(job, url) {
  let embedUrl;
  if (url.match(scribdRegex.DOCUMENT)) {
    const id = scribdRegex.DOCUMENT.exec(url)[2];
    embedUrl = `https://www.scribd.com/embeds/${id}/content`;
  } else if (url.match(scribdRegex.EMBED)) {
    embedUrl = url;
  } else {
    throw new Error(`Unsupported Scribd URL: ${url}`);
  }

  const embedMatch = scribdRegex.EMBED.exec(embedUrl);
  if (!embedMatch) throw new Error(`Cannot parse embed URL: ${embedUrl}`);
  const docId = embedMatch[1];

  job.message = 'Launching browser...';
  job.progress = 5;

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    job.message = 'Loading Scribd document...';
    job.progress = 10;
    await page.goto(embedUrl, { waitUntil: 'load', timeout: 60000 });
    await injectHelpers(page);
    await new Promise(r => setTimeout(r, 1000));

    job.message = 'Processing document pages...';
    job.progress = 20;

    const { title, pages } = await page.evaluate(async (rt) => {
      ['div.customOptInDialog', "div[aria-label='Cookie Consent Banner']"].forEach(sel => {
        window.__helpers__.removeSelectorAll(sel);
      });
      await window.__helpers__.lazyLoad('div.document_scroller', rt);
      window.__helpers__.removeMarginSelectorAll("div.outer_page_container div[id^='outer_page_']");

      const overlay = document.querySelector('div.mobile_overlay a');
      const title = overlay ? decodeURIComponent(overlay.href.split('/').pop().trim()) : null;
      const pages = [];
      document.querySelectorAll("div.outer_page_container div[id^='outer_page_']").forEach(dom => {
        const style = getComputedStyle(dom);
        pages.push({ id: dom.id, width: parseInt(style.width), height: parseInt(style.height) });
      });
      document.body.innerHTML = document.querySelector('div.outer_page_container').innerHTML;
      return { title, pages };
    }, 500);

    job.totalPages = pages.length;
    job.message = `Found ${pages.length} pages, generating PDF...`;
    job.progress = 40;

    const identifier = sanitize(title || docId) || docId;
    ensureDir(OUTPUT_DIR);
    const pdfPath = path.join(OUTPUT_DIR, `${identifier}.pdf`);

    const allSameDimensions = pages.every(
      p => p.width === pages[0].width && p.height === pages[0].height
    );

    if (allSameDimensions) {
      await page.pdf({
        path: pdfPath,
        printBackground: true,
        width: pages[0].width,
        height: pages[0].height,
        timeout: 0,
      });
      job.currentPage = pages.length;
      job.progress = 90;
    } else {
      const tempDir = path.join(OUTPUT_DIR, `${identifier}_temp`);
      ensureDir(tempDir);

      const groups = groupPagesByDimensions(pages);
      const pdfPaths = [];

      await page.evaluate(() => window.__helpers__.hideSelectorAll("div[id^='outer_page_']"));

      for (let i = 0; i < groups.length; i++) {
        await page.evaluate((ids) => {
          window.__helpers__.showSelectorAll(ids.map(id => `div#${id}`).join(','));
        }, groups[i].ids);

        const groupPdfPath = path.join(tempDir, `${String(i + 1).padStart(5, '0')}.pdf`);
        await page.pdf({
          path: groupPdfPath,
          printBackground: true,
          width: groups[i].width,
          height: groups[i].height,
          timeout: 0,
        });
        pdfPaths.push(groupPdfPath);

        await page.evaluate((ids) => {
          window.__helpers__.removeSelectorAll(ids.map(id => `div#${id}`).join(','));
        }, groups[i].ids);

        job.currentPage = i + 1;
        job.progress = 40 + Math.floor(((i + 1) / groups.length) * 48);
        job.message = `Rendering group ${i + 1} of ${groups.length}...`;
      }

      job.message = 'Merging PDF pages...';
      job.progress = 90;

      const merged = await PDFDocument.create();
      for (const p of pdfPaths) {
        const bytes = await fsp.readFile(p);
        const doc = await PDFDocument.load(bytes);
        const copied = await merged.copyPages(doc, doc.getPageIndices());
        copied.forEach(pg => merged.addPage(pg));
      }
      const mergedBytes = await merged.save();
      await fsp.writeFile(pdfPath, mergedBytes);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    job.filePath = pdfPath;
    job.filename = `${identifier}.pdf`;
    job.progress = 95;
    job.message = 'Finalizing...';
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function downloadSlideshare(job, url) {
  let slideId;
  if (url.match(slideshareRegex.SLIDESHOW)) {
    slideId = slideshareRegex.SLIDESHOW.exec(url)[1];
  } else if (url.match(slideshareRegex.PPT)) {
    slideId = slideshareRegex.PPT.exec(url)[1];
  } else {
    throw new Error(`Unsupported Slideshare URL: ${url}`);
  }

  job.message = 'Launching browser...';
  job.progress = 5;

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    job.message = 'Loading Slideshare presentation...';
    job.progress = 10;
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await injectHelpers(page);

    const { title } = await page.evaluate(async (rt) => {
      await window.__helpers__.lazyLoad(null, rt);
      const h1 = document.querySelector('h1.title');
      const title = h1 ? decodeURIComponent(h1.textContent.trim()) : null;
      return { title };
    }, 500);

    const srcs = await page.$$eval("img[id^='slide-image-']", imgs => imgs.map(img => img.src));

    job.totalPages = srcs.length;
    job.message = `Downloading ${srcs.length} slides...`;
    job.progress = 20;

    const identifier = sanitize(title || slideId) || slideId;
    ensureDir(OUTPUT_DIR);
    const pdfPath = path.join(OUTPUT_DIR, `${identifier}.pdf`);
    const tempDir = path.join(OUTPUT_DIR, `${slideId}_temp`);
    ensureDir(tempDir);

    const images = [];
    for (let i = 0; i < srcs.length; i++) {
      const imagePath = path.join(tempDir, `${String(i + 1).padStart(5, '0')}.png`);
      const resp = await axios.get(srcs[i], { responseType: 'arraybuffer', timeout: 30000 });
      const imageBuffer = await sharp(resp.data).toFormat('png').toBuffer();
      fs.writeFileSync(imagePath, imageBuffer);
      const metadata = await sharp(imagePath).metadata();
      images.push(new Image(imagePath, metadata.width, metadata.height));

      job.currentPage = i + 1;
      job.progress = 20 + Math.floor(((i + 1) / srcs.length) * 60);
      job.message = `Downloading slide ${i + 1} of ${srcs.length}...`;
    }

    job.message = 'Generating PDF...';
    job.progress = 83;

    const pdfDoc = await PDFDocument.create();
    for (const img of images) {
      const imageBytes = await fsp.readFile(img.path);
      const pngImage = await pdfDoc.embedPng(imageBytes);
      const pg = pdfDoc.addPage([img.width, img.height]);
      pg.drawImage(pngImage, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const pdfBytes = await pdfDoc.save();
    await fsp.writeFile(pdfPath, pdfBytes);

    fs.rmSync(tempDir, { recursive: true, force: true });

    job.filePath = pdfPath;
    job.filename = `${identifier}.pdf`;
    job.currentPage = srcs.length;
    job.progress = 95;
    job.message = 'Finalizing...';
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function downloadEverand(job, url) {
  let listenUrl;
  if (url.match(everandRegex.PODCAST_EPISODE)) {
    const episodeId = everandRegex.PODCAST_EPISODE.exec(url)[1];
    listenUrl = `https://www.everand.com/listen/podcast/${episodeId}`;
  } else if (url.match(everandRegex.PODCAST_LISTEN)) {
    listenUrl = url;
  } else if (url.match(everandRegex.PODCAST_SERIES)) {
    throw new Error('Series download is not supported via the web UI. Please provide a specific episode URL.');
  } else {
    throw new Error(`Unsupported Everand URL: ${url}`);
  }

  const listenMatch = everandRegex.PODCAST_LISTEN.exec(listenUrl);
  const episodeId = listenMatch[1];

  job.message = 'Launching browser...';
  job.progress = 5;

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    job.message = 'Loading Everand podcast page...';
    job.progress = 10;
    await page.goto(listenUrl, { waitUntil: 'load', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));

    job.message = 'Extracting audio URL...';
    job.progress = 20;

    const title = await page.evaluate(() => {
      try { return eval('Scribd.current_doc.short_title'); } catch { return null; }
    });

    const audioUrl = await page.evaluate(() => {
      const el = document.querySelector('audio#audioplayer');
      return el ? el.src : null;
    });

    if (!audioUrl) {
      throw new Error('Could not find audio URL. The podcast may require an active subscription.');
    }

    job.message = 'Downloading audio file...';
    job.progress = 30;

    const identifier = sanitize(title || episodeId) || episodeId;
    ensureDir(OUTPUT_DIR);
    const mp3Path = path.join(OUTPUT_DIR, `${identifier}.mp3`);

    const resp = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      onDownloadProgress: (evt) => {
        if (evt.total) {
          const pct = Math.floor((evt.loaded / evt.total) * 60);
          job.progress = 30 + pct;
          job.message = `Downloading audio... ${Math.floor((evt.loaded / evt.total) * 100)}%`;
        }
      },
    });
    fs.writeFileSync(mp3Path, Buffer.from(resp.data));

    job.filePath = mp3Path;
    job.filename = `${identifier}.mp3`;
    job.progress = 95;
    job.message = 'Finalizing...';
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Execute a download job, updating job fields in place as progress changes.
 * Throws on error (after marking job.status = 'failed').
 * @param {object} job  The job object from jobStore
 */
export async function execDownload(job) {
  const startTime = Date.now();
  const timer = setInterval(() => {
    job.elapsedTime = Math.floor((Date.now() - startTime) / 1000);
  }, 1000);

  try {
    job.status = 'processing';
    job.message = 'Starting download...';
    ensureDir(OUTPUT_DIR);

    const { url } = job;
    if (url.match(scribdRegex.DOMAIN)) {
      await downloadScribd(job, url);
    } else if (url.match(slideshareRegex.DOMAIN)) {
      await downloadSlideshare(job, url);
    } else if (url.match(everandRegex.DOMAIN)) {
      await downloadEverand(job, url);
    } else {
      throw new Error('Unsupported URL');
    }

    job.status = 'completed';
    job.progress = 100;
    job.message = 'Download complete!';

    if (job.filePath && fs.existsSync(job.filePath)) {
      job.fileSize = fs.statSync(job.filePath).size;
    }
  } catch (err) {
    job.status = 'failed';
    job.message = err.message || 'Download failed';
    throw err;
  } finally {
    clearInterval(timer);
    job.elapsedTime = Math.floor((Date.now() - startTime) / 1000);
  }
}
