import { v4 as uuidv4 } from 'uuid';
import * as scribdRegex from '../../src/const/ScribdRegex.js';
import * as slideshareRegex from '../../src/const/SlideshareRegex.js';
import * as everandRegex from '../../src/const/EverandRegex.js';
import { jobs } from '../../src/lib/jobStore.js';
import { execDownload } from '../../src/lib/webDownloader.js';
import fs from 'fs';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { url } = req.body ?? {};
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const isValid =
      url.match(scribdRegex.DOMAIN) ||
      url.match(slideshareRegex.DOMAIN) ||
      url.match(everandRegex.DOMAIN);

    if (!isValid) {
      return res.status(400).json({
        error: 'Unsupported URL. Please use a Scribd, Slideshare, or Everand URL.',
      });
    }

    const jobId = uuidv4();
    const job = {
      id: jobId,
      url,
      status: 'pending',
      progress: 0,
      message: 'Queued...',
      currentPage: 0,
      totalPages: 0,
      filename: null,
      filePath: null,
      fileSize: null,
      createdAt: Date.now(),
      elapsedTime: 0,
    };
    jobs.set(jobId, job);

    // Fire-and-forget; errors are captured inside execDownload
    execDownload(job).catch(err => {
      const j = jobs.get(jobId);
      if (j && j.status !== 'failed') {
        j.status = 'failed';
        j.message = err.message;
      }
    });

    return res.status(200).json({ jobId });

  } else if (req.method === 'GET') {
    const { jobId } = req.query;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    const job = jobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'File not ready yet' });
    }

    try {
      const fileBuffer = await fs.promises.readFile(job.filePath);
      res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', fileBuffer.length);
      return res.send(fileBuffer);
    } catch {
      return res.status(500).json({ error: 'Failed to read output file' });
    }

  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}
